/**
 * 脏文档覆盖层（P0-1 脏文档一致性）。
 *
 * 背景：daemon 是独立进程，看不到 VSCode 的内存文档，所有读取都落到磁盘；而用户正在
 * 编辑、尚未保存时磁盘内容是**过期**的。于是出现两种事故：
 *  1. 上下文里带着缓冲区全文（`contextCapture` 用 `doc.getText()`），Agent 以为看到的是
 *     最新内容，可它随后 `read_file` 拿到的却是旧磁盘内容 → 推理与事实不一致；
 *  2. Agent 基于旧内容产出补丁，用户一点「应用」，磁盘就被写成了"抹掉未保存改动"的版本。
 *
 * 解法：客户端把当前全部脏文档推给 daemon（`workspace.syncDirty`，全量快照），daemon 以
 * **连接**为单位维护这份覆盖层；所有读取路径先查覆盖层、未命中再落磁盘。
 *
 * ## 内容可缺省
 * 超大文件不值得每次按键都把全文推过 WebSocket，故**内容可以缺席**：此时条目只表达
 * 「这个文件是脏的」。两者语义分工明确，不可混用：
 *  - `get()` 为 string → 读取用覆盖层内容（这才是"用户看到的内容"）
 *  - `has()` 为 true  → 文件处于未保存状态，**写入路径不得碰磁盘**（必须转交编辑器）
 *
 * 键用 `pathKey(canonicalizeTarget(path))`：与工具侧护栏 `resolveTarget` 产出的 canonical
 * 路径同源，且抹平 Windows 大小写差异，避免"路径看起来一样却查不到"。
 */
import { DirtyFileEntry } from '../../shared/protocol';
import { canonicalizeTarget, pathKey } from './paths';

/** 条目上限：防止异常客户端把内存刷爆。 */
export const MAX_OVERLAY_FILES = 500;

export class DirtyOverlay {
  /** value 为 undefined 表示「脏，但内容未上报（超大文件）」 */
  private files = new Map<string, string | undefined>();

  /**
   * 用一份**全量快照**替换覆盖层（不做增量合并）。
   *
   * 非法条目（非字符串路径、空路径、路径无法 canonical 化 / 含 NUL 与 ADS）直接跳过，
   * 返回实际纳入的条目数，便于日志与测试断言。
   */
  replace(entries: DirtyFileEntry[]): number {
    const next = new Map<string, string | undefined>();
    if (!Array.isArray(entries)) {
      this.files = next;
      return 0;
    }
    // 先归一化再按路径排序，保证「超上限截断」的结果是确定性的
    const normalized: Array<{ key: string; content: string | undefined }> = [];
    for (const e of entries) {
      if (!e || typeof e.path !== 'string' || !e.path) continue;
      let key: string;
      try {
        key = pathKey(canonicalizeTarget(e.path));
      } catch {
        continue; // NUL / ADS / 无法解析：不可信条目直接丢弃
      }
      normalized.push({ key, content: typeof e.content === 'string' ? e.content : undefined });
    }
    normalized.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    for (const { key, content } of normalized) {
      if (next.size >= MAX_OVERLAY_FILES) break;
      next.set(key, content);
    }
    this.files = next;
    return next.size;
  }

  /** 覆盖层内容；键必须是 canonical 路径。返回 undefined 表示「无内容可用」（含内容未上报）。 */
  get(canonicalPath: string): string | undefined {
    return this.files.get(pathKey(canonicalPath));
  }

  /** 该文件是否处于未保存状态（**无论内容是否上报**）——写入路径应据此避开磁盘。 */
  has(canonicalPath: string): boolean {
    return this.files.has(pathKey(canonicalPath));
  }

  clear(): void {
    this.files.clear();
  }

  get size(): number {
    return this.files.size;
  }
}
