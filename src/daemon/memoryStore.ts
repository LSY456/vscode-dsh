/**
 * 长期记忆（跨会话保留的用户偏好）。
 *
 * 为什么需要它：Agent 每开一场新会话都从零开始 —— 用户上一轮纠正过的偏好
 * （「别用 tab 缩进」「这个项目禁 npm」）不会留下来，下次照样犯。会话历史能回放旧对话，
 * 但把旧对话整段塞回上下文既贵又吵，需要的只是那几句结论。
 *
 * 三条设计约束，与项目既有的取舍一致：
 *  ① **写入必须经人确认**。记忆由模型提出、用户批准才落盘（`remember` 工具的审批卡），
 *     不做自动抽取 —— 自动写进去的偏好若错了，用户根本不知道它正在影响后续回答。
 *  ② **进提示词有硬上限**。系统提示词是每轮重发的固定开销，而记忆是其中唯一会长期增长的
 *     部分，所以条数、单条长度、整段字符数三处都封顶；超了**显式说明**，不静默截断。
 *  ③ **文件可审阅、可删除**。落在 `<workspace>/.dsh/memory.json`（0600、原子写），
 *     设置面板里逐条可见可删，也能一键清空。
 *
 * 纯逻辑 + 文件依赖注入（与 `trust.ts` 同一套写法），便于确定性测试。
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  MAX_MEMORY_ENTRIES,
  MAX_MEMORY_TEXT,
  MEMORY_PROMPT_MAX_CHARS,
  MemoryEntryData,
} from '../../shared/protocol';

export interface MemoryStoreOptions {
  /** 持久化文件路径（`<workspace>/.dsh/memory.json`） */
  file: string;
  now?: () => number;
}

/**
 * `add()` 的结果。
 *
 * 失败原因分列而不是合成一句话：`duplicate` 是「已经记住了」（好消息），
 * `full` 是「该清理了」，`io` 是「环境有问题」—— 三种情况用户要做的事完全不同。
 *
 * 落盘失败**不算写入失败**（条目已在本会话生效），但必须如实告诉用户"重启后不保留"，
 * 所以成功结果带 `persisted`：说"已记住"却在重启后消失，是这类功能最伤信任的失败。
 */
export type MemoryAddResult =
  | { ok: true; entry: MemoryEntryData; persisted: boolean }
  | { ok: false; reason: 'empty' | 'duplicate' | 'full' | 'io'; message: string };

/**
 * 单条记忆的清洗：压掉换行与连续空白、去掉首尾空格、截到上限。
 *
 * 必须**单行化**：记忆会被拼进系统提示词，多行内容可以伪造出「- 」项目符号甚至一段
 * 看似属于提示词的说明。压成一行就构造不出新的结构。
 */
export function normalizeMemoryText(raw: unknown): string {
  return String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_MEMORY_TEXT);
}

/** 段落标题（也是"这些不是本轮指令"的声明，避免模型把旧偏好当成本轮命令）。 */
const SECTION_HEADER =
  '【长期记忆】（用户此前明确要求你记住的偏好与约定，按时间从旧到新；' +
  '与用户本轮的明确指令冲突时以本轮为准，并说明你按哪个执行）';

/**
 * 把记忆条目渲染成一段系统提示词附录。
 *
 * 取的是**最新**的若干条：一旦超出字符预算，宁可丢最旧的并明说还剩多少条，
 * 也不静默截断半句话（半句话比没有更误导）。空列表返回空串 —— 调用方据此
 * 完全不加这段，未使用记忆的会话请求体逐字节不变。
 */
export function buildMemorySection(
  entries: MemoryEntryData[],
  maxChars: number = MEMORY_PROMPT_MAX_CHARS
): string {
  if (!entries || entries.length === 0) return '';
  // 新 → 旧，按预算先装满；展示时再翻回旧 → 新
  const ordered = [...entries].sort((a, b) => b.createdAt - a.createdAt);
  const picked: string[] = [];
  let used = SECTION_HEADER.length;
  for (const e of ordered) {
    const line = '- ' + e.text;
    // +1 是换行符本身
    if (used + line.length + 1 > maxChars) break;
    picked.push(line);
    used += line.length + 1;
  }
  if (picked.length === 0) return '';
  const omitted = ordered.length - picked.length;
  const lines = [SECTION_HEADER, ...picked.reverse()];
  if (omitted > 0) lines.push(`（另有 ${omitted} 条更早的记忆未展开，可在设置面板查看或删除）`);
  return lines.join('\n');
}

export class MemoryStore {
  private entries = new Map<string, MemoryEntryData>();

  constructor(private readonly opts: MemoryStoreOptions) {
    this.load();
  }

  /**
   * 读盘。文件缺失视为空；**解析失败不覆盖内存中的已有条目** ——
   * 一次读坏就把用户刚批准的记忆清空，比读不到更糟。
   */
  private load(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.opts.file, 'utf8');
    } catch {
      return; // 没有文件：保持现状（首次运行时就是空）
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.error(
        `[memory] 记忆文件解析失败，本次沿用内存中的条目: ${e instanceof Error ? e.message : String(e)}`
      );
      return;
    }
    const list = (parsed as { entries?: unknown })?.entries;
    if (!Array.isArray(list)) return;
    const next = new Map<string, MemoryEntryData>();
    for (const item of list) {
      const e = item as MemoryEntryData;
      if (!e || typeof e.id !== 'string' || typeof e.text !== 'string') continue;
      if (typeof e.createdAt !== 'number' || !Number.isFinite(e.createdAt)) continue;
      const text = normalizeMemoryText(e.text);
      if (!text) continue;
      next.set(e.id, { id: e.id, text, createdAt: e.createdAt });
    }
    this.entries = next;
  }

  /**
   * 落盘：先写临时文件再 rename。
   *
   * 直接覆写时若进程在写一半被杀，留下的是**半截 JSON** —— 下次启动整份记忆都读不出来。
   * rename 在同一分区上是原子的：要么是旧内容，要么是新内容。
   *
   * 返回是否真的落盘成功，由调用方决定怎么告知用户（不在这里吞掉失败）。
   */
  private persist(): boolean {
    const file = this.opts.file;
    const tmp = `${file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries: [...this.entries.values()] }, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
      });
      fs.renameSync(tmp, file);
      return true;
    } catch (e) {
      console.error(`[memory] 记忆持久化失败: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  /** 全部条目（新 → 旧）。读前先刷一次盘，让另一个窗口的改动也能看到。 */
  list(): MemoryEntryData[] {
    this.load();
    return [...this.entries.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  /** 记忆段落（供系统提示词）。 */
  section(): string {
    return buildMemorySection(this.list());
  }

  /** 用户批准后写入一条。重复（忽略大小写）与超上限都**明确拒绝**，不静默替换/淘汰。 */
  add(raw: string): MemoryAddResult {
    this.load();
    const text = normalizeMemoryText(raw);
    if (!text) return { ok: false, reason: 'empty', message: '内容为空，未写入。' };
    const key = text.toLowerCase();
    for (const e of this.entries.values()) {
      if (e.text.toLowerCase() === key) {
        return { ok: false, reason: 'duplicate', message: '这条已经在长期记忆里了，未重复写入。' };
      }
    }
    if (this.entries.size >= MAX_MEMORY_ENTRIES) {
      return {
        ok: false,
        reason: 'full',
        message: `长期记忆已达上限（${MAX_MEMORY_ENTRIES} 条），未写入。请先在设置面板删掉不再需要的条目。`,
      };
    }
    const now = this.opts.now?.() ?? Date.now();
    const entry: MemoryEntryData = {
      id: `mem_${now}_${Math.random().toString(36).slice(2, 8)}`,
      text,
      createdAt: now,
    };
    this.entries.set(entry.id, entry);
    // 条目先留下：本会话立刻生效；只是要不要承诺"已保存"取决于落盘结果
    return { ok: true, entry, persisted: this.persist() };
  }

  /** 删除一条；返回是否真的删掉了（区分"删了"与"本来就没有"）。 */
  remove(id: string): boolean {
    this.load();
    if (!this.entries.has(id)) return false;
    this.entries.delete(id);
    this.persist();
    return true;
  }

  clear(): void {
    this.entries.clear();
    this.persist();
  }
}
