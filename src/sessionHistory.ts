/**
 * 会话历史存储（A3）。
 *
 * 真实诉求：webview 面板一旦销毁重开，进程内 DOM 状态全失、对话记录丢失。
 * 因此历史必须落在 extension 侧持久化，而非 webview 的 localStorage（面板关闭即销毁）。
 *
 * 设计要点（企业级约束）：
 *  - 依赖注入 MementoLike（只声明 get/update），生产用 vscode.Memento（workspaceState），
 *    测试用内存假体做确定性验证，不依赖 vscode 运行时；
 *  - 每次追加即持久化（用户量级小、写频繁但代价可接受），并统一裁剪到最近 MAX_SESSIONS 个会话、
 *    单条消息截断到 MAX_MESSAGE_LEN，避免 workspaceState 无限膨胀；
 *  - 流式回答以「内存暂挂 delta + finishAssistant 落盘」的方式累积，避免每个 token 都写存储；
 *    endSession 兜底调 finishAssistant，保证异常中断时最后一段回答也不丢。
 */
export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
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