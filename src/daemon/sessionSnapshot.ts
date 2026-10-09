/**
 * 会话级事务回滚（P2-6）：影子快照 + 一键还原到「本次会话开始前」。
 *
 * 与既有的 Diff 审批**互补**而不是替代：审批是**事前拦截**（改之前让你看 Diff），
 * 回滚是**事后兜底**（改完了、发现不对，能退回去）。两者缺一，用户都只能靠 git 自救。
 *
 * 四条设计取舍（每一条都是被别的方案坑过才这么定的）：
 *
 * ① **懒惰快照，而不是会话开始时全量快照**：
 *    会话开始时并不知道会动哪些文件，全量快照一个仓库既慢又占空间（而且会连带快照一堆无关文件）。
 *    改为在**每个文件第一次被写入之前**把它当时的内容存下来 —— 需要回滚的恰好就是"被改过的那些"，
 *    一份不多一份不少。
 *
 * ② **首写优先**：同一文件在本次会话被改多次时，只有**第一次**会留下快照。
 *    否则回滚退到的是"上一次修改前"，而不是"这次会话开始前" —— 后者才是用户点「回滚」时的心智模型。
 *
 * ③ **不碰脏文档**：还原与「应用补丁」走同一条安全原则 —— 目标文件在编辑器里有未保存改动时
 *    **拒绝还原并如实回报**。悄悄覆盖用户正在编辑的内容，比"回滚失败"严重得多。
 *
 * ④ **还原前重做路径校验**：索引文件是本机任意进程可写的普通文件（同 `.dsh/` 下的其它文件），
 *    被篡改时不能让它把 daemon 变成"写任意路径"的工具。每条路径都重新过一遍 canonical 护栏，
 *    **内容文件名（blob）同理** —— 它与 path 出自同一个索引文件，只校验 path 等于留了半扇门。
 *
 * ⑤ **还原前比对写入指纹**：③ 只挡得住"编辑器里还没保存"的改动；用户改完**保存**之后文件不脏，
 *    ③ 就失效了 —— 回滚会把用户的改动连同 Agent 的一起退回，而报告还显示"全部成功"。
 *    故每次写入后记下**写入内容**的哈希，还原前读磁盘比对，不一致即归入「内容已变」跳过。
 *    这条与补丁链路上的乐观锁（`checkPatchConflict`）是同一纪律，只是换了个时间点。
 *
 * 快照只增不改：清理交给用户（`.dsh/` 本就是可随手删掉的旁路目录）。任何一步失败都**不抛异常**
 * —— 留不下快照不是让写盘失败的理由，但必须说出来（经 `log`），否则用户会在回滚时才发现少了一个文件。
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { assertPathInside, pathKey } from './paths';
import { deleteFile, writeTextFile } from './tools';

/** 单文件快照留存上限：超过就不留内容（只记"改过"），回滚时如实报为不可还原。 */
export const DEFAULT_MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
/** 单会话快照条目上限：防止一次超长会话把磁盘写满。超出部分计数上报，不静默丢弃。 */
export const DEFAULT_MAX_SNAPSHOT_ENTRIES = 1000;

/** 索引文件名（每个会话一份）。 */
const INDEX_FILE = 'index.json';
const INDEX_VERSION = 1;

/** index.json 里的一条：一个被改动过的文件。 */
export interface SnapshotEntry {
  /** 目标文件 canonical 绝对路径 */
  path: string;
  /** 记录时文件是否存在：false = 本次会话新建的，回滚即「删除」 */
  existed: boolean;
  /** 快照内容文件名（`existed=false` 或未留存时为 null） */
  blob: string | null;
  /** 原始内容字节数（已留存时） */
  bytes?: number;
  /**
   * 本次会话**最后一次写入**该文件的内容指纹（sha256 hex）。
   *
   * 用途见文件头 ⑤：还原前拿磁盘内容比对，不一致说明文件在会话之后被别的通路动过，
   * 一律跳过而不覆盖。取"最后一次"而非"第一次"是因为还原要防的是"磁盘现在是不是我留下的样子"。
   *
   * 为 `null` / `undefined` 表示**未能观测到写入内容**（例如老版本索引、或改动发生在编辑器
   * 缓冲区里而 daemon 无从读取最终结果）—— 此时只能退回到"仅按脏文档判定"。
   */
  afterHash?: string | null;
  /** 记录时刻（epoch ms） */
  recordedAt: number;
  /** 未能留存内容的原因（有值时该条无法回滚，但仍要如实出现在报告里） */
  unrestorable?: string;
}

interface SnapshotIndex {
  version: number;
  /** 因条目上限而**完全没记下来**的改动数（回滚报告据此提示"回滚可能不完整"） */
  dropped: number;
  entries: SnapshotEntry[];
}

/** 单次还原的结果。每一类都显式列出 —— 不做"静默跳过"。 */
export interface RestoreReport {
  /** 快照覆盖的改动文件总数 */
  total: number;
  /** 已还原为会话开始前的内容 */
  restored: string[];
  /** 本次会话新建、已删除的文件 */
  deleted: string[];
  /** 因编辑器有未保存改动而跳过（需用户先保存或放弃改动再回滚） */
  skippedDirty: string[];
  /**
   * 因文件在**本次会话之后被别的通路改过**（用户保存 / 外部工具 / 另一会话）而跳过。
   * 与 `skippedDirty` 分开列：一个是"先保存再说"，一个是"先看看这是什么改动"。
   */
  changedAfter: { path: string; reason: string }[];
  /** 记录时就未能留存内容（文件过大），无法回滚 */
  unrestorable: { path: string; reason: string }[];
  /** 还原过程中写盘 / 删除失败 */
  failed: { path: string; error: string }[];
  /** 因快照条目上限而未被记录的改动数（> 0 时回滚可能不完整） */
  unrecorded: number;
}

export interface SessionSnapshotOptions {
  /** 快照根目录（`<workspace>/.dsh/snapshots`） */
  root: string;
  /** 工作区根：还原前对每条路径重做 canonical 越界校验 */
  workspaceRoot: string;
  /** 还原时写入用的 allowedDirs（与连接级能力一致） */
  allowedDirs?: string[];
  maxBytesPerFile?: number;
  maxEntries?: number;
  now?: () => number;
  /** 失败出口（默认 console.warn → tee 到 .dsh/logs/daemon.log）。测试注入以断言"失败被说出来了"。 */
  log?: (message: string) => void;
}

/**
 * 会话 id → 安全的目录名段。
 *
 * 会话 id 由 daemon 自己生成（`sess_<base36>`），理应安全；但这里仍做收敛 ——
 * 它是拼进文件路径的，而"拼进路径"的东西一旦将来来源变化（比如客户端指定会话 id），
 * 一个 `../` 就能把快照写到工作区外。
 *
 * 做法刻意是**白名单字符集**而不是黑名单比对：允许的字符里根本不含 `.` 与路径分隔符，
 * 于是 `.` / `..` 这类特殊目录项在字符集层面就不可能构造出来 —— 不用去猜还有哪些变形。
 */
export function safeSessionSegment(sessionId: string): string {
  const cleaned = sessionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  return cleaned || '_unnamed';
}

/**
 * 快照内容文件名是否安全（拼进路径前校验）。
 *
 * 与 `safeSessionSegment` 同一个理由：`blob` 字段来自**可被本机任意进程改写**的 `index.json`，
 * 直接 `path.join(dir, blob)` 就等于把"读哪个文件"的决定权交了出去（`../../Windows/win.ini`）。
 * 记录侧只会产出 `blob_NNNN.snap`，那就只接受这一种形状 —— 白名单比黑名单少猜很多变形。
 */
export function isSafeBlobName(name: string): boolean {
  return /^blob_\d{1,6}\.snap$/.test(name);
}

/** 内容指纹（sha256 hex）。用途见文件头 ⑤；不做盐/不做 HMAC —— 这是"有没有被改过"而非防伪造。 */
function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

export class SessionSnapshotStore {
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(private readonly opts: SessionSnapshotOptions) {
    this.maxBytes = opts.maxBytesPerFile ?? DEFAULT_MAX_SNAPSHOT_BYTES;
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_SNAPSHOT_ENTRIES;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m) => console.warn(`[dsh-daemon] ${m}`));
  }

  /** 某会话的快照目录（不存在时不会被创建）。 */
  dirOf(sessionId: string): string {
    return path.join(this.opts.root, safeSessionSegment(sessionId));
  }

  /**
   * 记录「这个文件即将被改动」——由落地裁决在真正写入**之前**调用。
   *
   * `originalContent` 取**首写优先**（会话开始前的样子）；`writtenContent` 是本会话**最后一次**
   * 写入的内容（用于还原前的指纹比对，见文件头 ⑤），可省略（表示无法观测最终内容）。
   */
  record(
    sessionId: string,
    filePath: string,
    originalContent: string | undefined,
    writtenContent?: string
  ): void {
    try {
      const index = this.readIndex(sessionId);
      const key = pathKey(filePath);
      const afterHash = writtenContent === undefined ? null : hashContent(writtenContent);

      const existing = index.entries.find((e) => pathKey(e.path) === key);
      if (existing) {
        // 首写优先只约束"改动前的内容"；写入指纹反过来取**最后一次** —— 它回答的是
        // "磁盘现在应该是谁留下的样子"。观测不到新内容时保留旧指纹，绝不清空。
        if (afterHash !== null && existing.afterHash !== afterHash) {
          existing.afterHash = afterHash;
          this.writeIndex(sessionId, index);
        }
        return;
      }

      if (index.entries.length >= this.maxEntries) {
        // 不静默丢弃：计数上报，回滚报告里会提示"回滚可能不完整"
        index.dropped += 1;
        this.writeIndex(sessionId, index);
        this.log(
          `会话 ${sessionId} 快照条目已达上限 ${this.maxEntries}，${filePath} 未纳入回滚（回滚将不完整）`
        );
        return;
      }

      const entry: SnapshotEntry = {
        path: filePath,
        existed: originalContent !== undefined,
        blob: null,
        afterHash,
        recordedAt: this.now(),
      };

      if (originalContent !== undefined) {
        const bytes = Buffer.byteLength(originalContent, 'utf8');
        if (bytes > this.maxBytes) {
          entry.unrestorable = `文件 ${bytes} 字节，超过快照上限 ${this.maxBytes} 字节`;
        } else {
          const dir = this.ensureDir(sessionId);
          const blob = `blob_${String(index.entries.length + 1).padStart(4, '0')}.snap`;
          fs.writeFileSync(path.join(dir, blob), originalContent, { encoding: 'utf8', mode: 0o600 });
          entry.blob = blob;
          entry.bytes = bytes;
        }
      }

      index.entries.push(entry);
      this.writeIndex(sessionId, index);
    } catch (e) {
      // 快照失败**不能**阻断写盘（那就本末倒置了），但必须说出来 —— 否则用户会在回滚时
      // 才发觉"这个文件不在列表里"，且无从解释。
      this.log(`会话 ${sessionId} 记录快照失败：${filePath}（${errText(e)}）`);
    }
  }

  /** 某会话已记录的快照条目（副本，只读用途）。 */
  list(sessionId: string): SnapshotEntry[] {
    return this.readIndex(sessionId).entries;
  }

  /** 某会话已记录的改动文件数（回滚清理时据此回报"丢弃了几条"）。 */
  count(sessionId: string): number {
    return this.readIndex(sessionId).entries.length;
  }

  /**
   * 把某会话记录到的全部改动还原到会话开始前。
   *
   * @param isDirty 判断目标文件此刻是否为「编辑器未保存」状态（由连接级覆盖层回答）。
   *                **为 true 一律跳过**：宁可回滚不全，也不覆盖用户正在编辑的内容。
   */
  restore(sessionId: string, isDirty: (resolvedPath: string) => boolean): RestoreReport {
    const index = this.readIndex(sessionId);
    const report: RestoreReport = {
      total: index.entries.length,
      restored: [],
      deleted: [],
      skippedDirty: [],
      changedAfter: [],
      unrestorable: [],
      failed: [],
      unrecorded: index.dropped,
    };
    const dir = this.dirOf(sessionId);

    for (const entry of index.entries) {
      // ④ 每条路径重新过护栏：index.json 被篡改时也不能写到工作区外
      let resolved: string;
      try {
        resolved = assertPathInside(this.opts.workspaceRoot, entry.path);
      } catch (e) {
        report.failed.push({ path: entry.path, error: `路径校验未通过，已跳过：${errText(e)}` });
        continue;
      }

      if (entry.unrestorable) {
        report.unrestorable.push({ path: entry.path, reason: entry.unrestorable });
        continue;
      }
      if (isDirty(resolved)) {
        report.skippedDirty.push(entry.path);
        continue;
      }
      // ⑤ 内容指纹：文件在会话之后被别的通路改过（用户保存 / 外部工具 / 另一会话）就不碰
      const drift = this.detectDrift(resolved, entry, dir);
      if (drift) {
        report.changedAfter.push({ path: entry.path, reason: drift });
        continue;
      }

      try {
        if (!entry.existed) {
          deleteFile(this.opts.workspaceRoot, this.opts.allowedDirs ?? [], resolved);
          report.deleted.push(entry.path);
          continue;
        }
        if (!entry.blob) {
          report.failed.push({ path: entry.path, error: '快照索引缺少内容引用' });
          continue;
        }
        // ④ `blob` 与 `path` 同源于可被篡改的 index.json，同样不能直接拼进路径
        if (!isSafeBlobName(entry.blob)) {
          report.failed.push({
            path: entry.path,
            error: `快照内容引用不合法（${entry.blob}），已拒绝读取`,
          });
          continue;
        }
        const content = fs.readFileSync(path.join(dir, entry.blob), 'utf8');
        writeTextFile(this.opts.workspaceRoot, this.opts.allowedDirs ?? [], resolved, content);
        report.restored.push(entry.path);
      } catch (e) {
        report.failed.push({ path: entry.path, error: errText(e) });
      }
    }

    if (report.failed.length > 0 || report.unrestorable.length > 0 || report.changedAfter.length > 0) {
      this.log(
        `会话 ${sessionId} 回滚未完全成功：失败 ${report.failed.length}、不可还原 ${report.unrestorable.length}、` +
          `内容已变 ${report.changedAfter.length}`
      );
    }
    return report;
  }

  /** 丢弃某会话的全部快照（回滚后可选的清理；不删也能留着再回滚一次）。 */
  clear(sessionId: string): number {
    const n = this.count(sessionId);
    try {
      fs.rmSync(this.dirOf(sessionId), { recursive: true, force: true });
    } catch (e) {
      this.log(`清理会话 ${sessionId} 快照失败：${errText(e)}`);
    }
    return n;
  }

  // ------------------------------------------------------------------ 内部

  /**
   * 判定「文件在本次会话之后是否被别的通路改过」（文件头 ⑤）。
   *
   * 返回非空字符串 = 已漂移（连同给用户看的原因）；`null` = 未发现漂移**或无法判定**。
   *
   * 无法判定（没有写入指纹：老索引 / 编辑器通路）时返回 `null` 而不是保守跳过 ——
   * 否则这两个常见情形会让回滚整体失效，那比"可能覆盖"更糟。
   */
  private detectDrift(resolved: string, entry: SnapshotEntry, dir: string): string | null {
    if (typeof entry.afterHash !== 'string') return null;
    let current: string;
    try {
      current = fs.readFileSync(resolved, 'utf8');
    } catch {
      // 读不到：会话**新建**的文件已消失 = 回滚目标（不存在）已达成，交给删除通路（它容忍缺失）；
      // 原本就存在的文件消失则确有变化，必须陈述，不能静默当成"还原成功"。
      return entry.existed ? '文件当前不存在（已被删除或改名），未还原' : null;
    }
    if (hashContent(current) === entry.afterHash) return null; // 正是本次会话写入的样子
    // 已经处于"会话开始前"：多半是刚刚回滚过一次（快照只增不改，重复点回滚是常见动作）。
    // 再还一次是幂等的，不该报成"内容已变"去吓用户。
    if (this.matchesSnapshot(dir, entry, current)) return null;
    return '文件内容在本次会话之后被修改过（如手工编辑并保存），未覆盖';
  }

  /** 当前内容是否已等同于快照留存的那份（即"已在会话开始前的状态"）。 */
  private matchesSnapshot(dir: string, entry: SnapshotEntry, current: string): boolean {
    if (!entry.existed || !entry.blob || !isSafeBlobName(entry.blob)) return false;
    try {
      return fs.readFileSync(path.join(dir, entry.blob), 'utf8') === current;
    } catch {
      return false;
    }
  }

  private ensureDir(sessionId: string): string {
    const dir = this.dirOf(sessionId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  /**
   * 读索引。文件缺失 / 损坏 / 版本不符一律当作**空索引**——
   * 快照是旁路数据，读不出来就退化成"没有可回滚的改动"，不该让会话逻辑炸掉。
   */
  private readIndex(sessionId: string): SnapshotIndex {
    const file = path.join(this.dirOf(sessionId), INDEX_FILE);
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<SnapshotIndex>;
      if (!raw || !Array.isArray(raw.entries)) return emptyIndex();
      const entries = raw.entries.filter(
        (e): e is SnapshotEntry =>
          !!e && typeof (e as SnapshotEntry).path === 'string' && typeof (e as SnapshotEntry).existed === 'boolean'
      );
      return {
        version: INDEX_VERSION,
        dropped: typeof raw.dropped === 'number' && raw.dropped > 0 ? raw.dropped : 0,
        entries: entries.map((e) => ({
          ...e,
          blob: typeof e.blob === 'string' ? e.blob : null,
          afterHash: typeof e.afterHash === 'string' ? e.afterHash : null,
        })),
      };
    } catch {
      return emptyIndex();
    }
  }

  /** 写索引：先写临时文件再改名，避免进程中断留下半截 JSON。 */
  private writeIndex(sessionId: string, index: SnapshotIndex): void {
    const dir = this.ensureDir(sessionId);
    const file = path.join(dir, INDEX_FILE);
    const tmp = `${file}.tmp`;
    const payload: SnapshotIndex = { version: INDEX_VERSION, dropped: index.dropped, entries: index.entries };
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  }
}

function emptyIndex(): SnapshotIndex {
  return { version: INDEX_VERSION, dropped: 0, entries: [] };
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
