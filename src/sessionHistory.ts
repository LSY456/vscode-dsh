/**
 * 会话历史存储（A3）。
 *
 * 真实诉求：webview 面板一旦销毁重开，进程内 DOM 状态全失、对话记录丢失。
 * 因此历史必须落在 extension 侧持久化，而非 webview 的 localStorage（面板关闭即销毁）。
 *
 * 设计要点（企业级约束）：
 *  - 依赖注入 MementoLike（只声明 get/update），生产用 FileMemento（文件后端，工作区
 *    .dsh/history.json，跨 daemon 重启/换机持久），测试用内存假体或临时文件做确定性验证，
 *    不依赖 vscode 运行时；
 *  - 每次追加即持久化（用户量级小、写频繁但代价可接受），并统一裁剪到最近 MAX_SESSIONS 个会话、
 *    单条消息截断到 MAX_MESSAGE_LEN，避免存储无限膨胀；
 *  - 流式回答以「内存暂挂 delta + finishAssistant 落盘」的方式累积，避免每个 token 都写存储；
 *    endSession 兜底调 finishAssistant，保证异常中断时最后一段回答也不丢。
 */
import * as fs from 'fs';
import * as path from 'path';
import { ensureDshDir } from '../shared/dshDir';

export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

/**
 * 文件后端（历史外置）：把 MementoLike 语义落到单 JSON 文件，跨 daemon 重启 / 换机持久。
 * 读失败返回 undefined、写失败静默忽略（历史非关键路径）；目录 0700、文件 0600（对话内容可能敏感）。
 * 写走异步串行队列（避免阻塞扩展宿主事件循环），读走内存缓存（get 同步零 IO）；flush() 供停止前排空。
 */
export class FileMemento implements MementoLike {
  private cache: Record<string, unknown> | null = null;
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  get<T>(key: string): T | undefined {
    if (!this.file) return undefined;
    return this.load()[key] as T | undefined;
  }

  update(key: string, value: unknown): Promise<void> {
    if (!this.file) return Promise.resolve();
    this.load()[key] = value;
    const write = this.pending.then(async () => {
      // P0-3：顺手补上 `.dsh/` 的自守 .gitignore（只在目录名恰为 `.dsh` 时才写，
      // 否则本函数被复用到临时目录时会越界塞忽略文件）
      ensureDshDir(path.dirname(this.file));
      await fs.promises.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      await fs.promises.writeFile(this.file, JSON.stringify(this.load(), null, 2), {
        encoding: 'utf8',
        mode: 0o600,
      });
    });
    this.pending = write.catch(() => {
      /* 忽略：历史非关键路径 */
    });
    return this.pending;
  }

  /** 等待所有挂起写完成（测试断言 / 停止前确保退出不丢）。 */
  flush(): Promise<void> {
    return this.pending;
  }

  private load(): Record<string, unknown> {
    if (this.cache !== null) return this.cache;
    let obj: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      obj = parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      obj = {};
    }
    this.cache = obj;
    return obj;
  }
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  text: string;
  ts: number;
}

export interface SessionRecord {
  sessionId: string;
  title: string;
  createdAt: number;
  endedAt?: number;
  messages: ChatMessage[];
}

export interface SessionSummary {
  sessionId: string;
  title: string;
  createdAt: number;
  endedAt?: number;
  messageCount: number;
}

const STORAGE_KEY = 'dsh.sessionHistory.v1';
export const MAX_SESSIONS = 50;
const MAX_MESSAGE_LEN = 40_000;
const TITLE_LEN = 40;

function summarize(text: string): string {
  const s = (text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > TITLE_LEN ? s.slice(0, TITLE_LEN) + '…' : s;
}

function truncate(text: string): string {
  return (text ?? '').length > MAX_MESSAGE_LEN
    ? (text ?? '').slice(0, MAX_MESSAGE_LEN) + '\n…[内容过长已截断]'
    : (text ?? '');
}

export class SessionHistoryStore {
  private readonly sessions = new Map<string, SessionRecord>();
  /** sessionId -> 该会话尚未落盘的流式回答累积文本 */
  private readonly pending = new Map<string, string>();

  constructor(private readonly memento: MementoLike, private readonly now: () => number = Date.now) {
    this.load();
  }

  private load(): void {
    const raw = this.memento.get<SessionRecord[]>(STORAGE_KEY);
    if (!Array.isArray(raw)) return;
    for (const rec of raw) {
      if (rec && typeof rec.sessionId === 'string') this.sessions.set(rec.sessionId, rec);
    }
  }

  /** 写回存储（并裁剪到最近 MAX_SESSIONS 个会话）。 */
  persist(): void {
    const sorted = [...this.sessions.values()].sort((a, b) => b.createdAt - a.createdAt);
    if (sorted.length > MAX_SESSIONS) {
      const keep = new Set(sorted.slice(0, MAX_SESSIONS).map((r) => r.sessionId));
      for (const id of [...this.sessions.keys()]) {
        if (!keep.has(id)) this.sessions.delete(id);
      }
    }
    void this.memento.update(STORAGE_KEY, [...this.sessions.values()]);
  }

  private ensure(sessionId: string): SessionRecord {
    let rec = this.sessions.get(sessionId);
    if (!rec) {
      rec = { sessionId, title: '', createdAt: this.now(), messages: [] };
      this.sessions.set(sessionId, rec);
    }
    return rec;
  }

  startSession(sessionId: string, title?: string): void {
    if (this.sessions.has(sessionId)) return;
    this.sessions.set(sessionId, {
      sessionId,
      title: summarize(title ?? ''),
      createdAt: this.now(),
      messages: [],
    });
    this.persist();
  }

  appendUser(sessionId: string, text: string): void {
    const rec = this.ensure(sessionId);
    if (!rec.title) rec.title = summarize(text);
    rec.messages.push({ role: 'user', text: truncate(text), ts: this.now() });
    this.persist();
  }

  /** 累积流式回答文本（不落盘；finishAssistant 时一次性落盘）。 */
  appendAssistantDelta(sessionId: string, delta: string): void {
    if (!delta) return;
    this.pending.set(sessionId, (this.pending.get(sessionId) ?? '') + delta);
  }

  finishAssistant(sessionId: string): void {
    const pending = this.pending.get(sessionId);
    this.pending.delete(sessionId);
    if (!pending) return;
    const rec = this.ensure(sessionId);
    rec.messages.push({ role: 'assistant', text: truncate(pending), ts: this.now() });
    this.persist();
  }

  appendSystem(sessionId: string, text: string): void {
    const rec = this.ensure(sessionId);
    rec.messages.push({ role: 'system', text: truncate(text), ts: this.now() });
    this.persist();
  }

  endSession(sessionId: string): void {
    this.finishAssistant(sessionId); // 兜底：未显式 finish 的最后一段流也落库
    const rec = this.sessions.get(sessionId);
    if (rec) {
      rec.endedAt = this.now();
      this.persist();
    }
  }

  /** 历史列表摘要，按创建时间倒序。 */
  list(): SessionSummary[] {
    return [...this.sessions.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((r) => ({
        sessionId: r.sessionId,
        title: r.title || '(空会话)',
        createdAt: r.createdAt,
        endedAt: r.endedAt,
        messageCount: r.messages.length,
      }));
  }

  get(sessionId: string): SessionRecord | undefined {
    return this.sessions.get(sessionId);
  }
}