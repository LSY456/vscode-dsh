/**
 * 真实工具沙箱（P3.3 / 企业级加固）。
 *
 * 只读文件导航（list/read）与受护栏的写入，以及受策略门控的高危命令执行。
 * 路径操作一律以 canonical 护栏（assertPathInside：realpath 解析，防符号链接/联结逃逸）
 * 做 "工作区 ∩ allowedDirs" 校验，越界抛 PathError（-32012）。
 *
 * 命令执行采用"默认拒绝"策略：无论如何配置，都会并集内置高危拒绝规则
 * （DEFAULT_DENY_PATTERNS），再叠加调用方显式 deny/allow 规则；实际执行通过可注入
 * runner 完成，默认走 child_process（daemon 运行期，windowsHide + maxBuffer 受限）。
 */
import * as fs from 'fs';
import * as path from 'path';
import { assertPathInside, isPathInside, PathError } from './paths';
import { CommandSandbox, ProcessSandbox, SandboxedCommand } from './sandbox';

export { PathError };

/**
 * 将 target 解析为 canonical 绝对路径并校验其位于工作区（且若声明则位于 allowedDirs）内。
 * 返回解析后的规范绝对路径（已解析符号链接/联结）；越界抛 PathError。
 */
export function resolveTarget(root: string, allowedDirs: string[], target: string): string {
  if (!target || typeof target !== 'string') {
    throw new Error('缺少目标路径');
  }
  const resolved = assertPathInside(root, target);
  if (allowedDirs.length > 0) {
    const insideAny = allowedDirs.some((d) => {
      try {
        assertPathInside(d, resolved);
        return true;
      } catch {
        return false;
      }
    });
    if (!insideAny) {
      throw new PathError(`路径越界：${target} 不在 allowedDirs 内`);
    }
  }
  return resolved;
}

export interface ListResult {
  names: string[];
}

export function listDirectory(root: string, allowedDirs: string[], dirPath?: string): ListResult {
  const resolved = resolveTarget(root, allowedDirs, dirPath || root);
  const entries = fs.readdirSync(resolved, { withFileTypes: true });
  return {
    names: entries.map((e) => (e.isDirectory() ? e.name + '/' : e.name)).sort(),
  };
}

export interface ReadTextResult {
  content: string;
  truncated: boolean;
}

export function readTextFile(
  root: string,
  allowedDirs: string[],
  filePath: string,
  maxBytes = 200 * 1024
): ReadTextResult {
  const resolved = resolveTarget(root, allowedDirs, filePath);
  const raw = fs.readFileSync(resolved, 'utf8');
  const truncated = raw.length > maxBytes;
  return { content: truncated ? raw.slice(0, maxBytes) : raw, truncated };
}

export interface FileRangeResult {
  /** 带行号的行内容（`行号| 内容`） */
  content: string;
  /** 实际返回的起始行（1-based） */
  startLine: number;
  /** 实际返回的结束行（1-based 含） */
  endLine: number;
  /** 文件总行数 */
  totalLines: number;
}

/** 单次范围读取的默认最大行数。 */
const DEFAULT_RANGE_LINES = 200;

/** 将 1-based 行号钳制到 [1, totalLines]；非有限值或小于 1 回退 1。 */
function clampLine(n: number, totalLines: number): number {
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.floor(n), totalLines);
}

/**
 * 对**已拆好的行数组**做行号范围切片（1-based 含），返回带行号的内容。
 *
 * 范围读取的唯一实现：`readFileRange`（磁盘直读）与 realAgent 的「脏文档优先」通路
 * （拿到的是编辑器缓冲区内容，可能尚未落盘）共用同一套钳制 / 截断语义，
 * 避免两条通路对 startLine / endLine 的解释发生漂移。
 */
export function sliceLines(
  lines: string[],
  opts: { startLine?: number; endLine?: number; maxLines?: number } = {}
): FileRangeResult {
  const totalLines = lines.length;
  const max = opts.maxLines ?? DEFAULT_RANGE_LINES;
  const start = clampLine(opts.startLine ?? 1, totalLines);
  const maxEnd = start + max - 1;
  let end = opts.endLine != null ? clampLine(opts.endLine, totalLines) : totalLines;
  end = Math.min(end, maxEnd);
  if (end < start) end = start;
  const content = lines
    .slice(start - 1, end)
    .map((text, i) => `${start + i}| ${text}`)
    .join('\n');
  return { content, startLine: start, endLine: end, totalLines };
}

/**
 * 读取文件的指定行号范围（1-based 含），返回带行号的内容，供 grep 定位后精读。
 * 单次最多 maxLines 行（缺省 200）；二进制 / 超大 / 越界走 readLines 与 resolveTarget 护栏。
 *
 * 注意：本函数**只读磁盘**。目标文件在编辑器中有未保存改动时应改用
 * `ctx.readFile(...)` 取有效内容后再交给 `sliceLines`，否则会读到过期内容（P0-1）。
 */
export function readFileRange(
  root: string,
  allowedDirs: string[],
  filePath: string,
  opts: { startLine?: number; endLine?: number; maxLines?: number } = {}
): FileRangeResult {
  const resolved = resolveTarget(root, allowedDirs, filePath);
  const lines = readLines(resolved, MAX_RANGE_FILE_BYTES);
  if (lines === null) throw new Error('无法读取文件内容（二进制或超大）');
  return sliceLines(lines, opts);
}

// ---------------------------------------------------------------------------
// 只读搜索：grep（跨文件关键字搜索）与 glob（文件名通配匹配）
// ---------------------------------------------------------------------------

export interface GrepMatch {
  /** 匹配文件绝对路径 */
  file: string;
  /** 1-based 行号 */
  line: number;
  /** 匹配行内容（已截断） */
  text: string;
}

export interface GrepResult {
  matches: GrepMatch[];
  truncated: boolean;
  /**
   * 遍历是否因预算（深度 / 条目 / 时间）提前中止。
   *
   * 与 `truncated` 分开表达的原因：`truncated` 只说明"结果被裁过"，而本字段说明**搜索本身没跑完** ——
   * 此时"无匹配"是不可断言的结论。调用方必须据此换一套文案，否则模型会把"没搜完"读成
   * "代码里没有这个符号"，接着反复换模式重试。
   */
  walkExhausted: boolean;
}

export interface GlobResult {
  files: string[];
  truncated: boolean;
  /** 同 `GrepResult.walkExhausted`：遍历被预算截断时"无匹配文件"不可断言 */
  walkExhausted: boolean;
}

const SKIP_DIRS = new Set(['.git', 'node_modules']);
const MAX_GREP_RESULTS = 200;
const MAX_GLOB_RESULTS = 200;
const MAX_GREP_LINE_LEN = 200;
const MAX_GREP_FILE_BYTES = 1024 * 1024;
/** grep pattern 长度上限：正则交给 V8 编译，防御性地挡住天量回溯型输入。 */
const MAX_GREP_PATTERN_LEN = 1000;
/**
 * 行号范围读取的独立大小上限（grep 之外，允许精读更大的单个文件）。
 * 也用作 realAgent 在「脏文档优先」通路下取内容时的字节上限，
 * 避免被常规 64KB 上限截断而取不到目标行。
 */
export const MAX_RANGE_FILE_BYTES = 16 * 1024 * 1024;

/** `*` 通配 → 正则（匹配 basename：`*` 匹配任意字符序列，其余字符转义）。 */
function globToRegex(pattern: string): RegExp {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('^' + pattern.split('*').map(escape).join('.*') + '$');
}

/**
 * 把 grep 的 pattern 编译为正则；非法正则返回 null（调用方回退字面量匹配）。
 *
 * 为什么必须支持正则：模型天然会写 `a|b|c`、`foo.*bar`、`\bname\b` 这类模式
 * （与 grep / ripgrep 的直觉一致）。早期实现只做字面量 `includes`，于是"多选一"的搜索
 * 一律返回无匹配 —— 模型会误判成"代码里没有这个符号"，接着反复换模式重试（实测一轮连错
 * 五次、把过程面板刷满）。这里按正则解析，语义与标准搜索工具对齐；
 * 非法正则（例如落单的 `(`）回退字面量，保证任何输入都给确定结果而不是抛错。
 */
function compilePattern(needle: string): RegExp | null {
  try {
    return new RegExp(needle);
  } catch {
    return null;
  }
}

/**
 * 递归遍历的预算上限（P1-2 加固）。
 *
 * 为什么必须有预算：`walkFiles` 是**同步**递归，跑在 daemon 的事件循环上。此前它没有任何上限，
 * 于是"在大仓库上 grep 一次"足以把事件循环占满 —— 心跳 ping 发不出去，客户端判定连接断开并重连，
 * 用户看到的是"连接断开"，而不是"搜索太慢"，完全无法归因。工作区里若存在 symlink 环，
 * 递归更是永不终止（`isDirectory()` 为真的链接目录会被反复跟随）。
 *
 * 三条上限分别挡住三种失控：条目数（宽而平的大仓库）、深度（深而窄的目录树）、
 * 墙钟时间（单个超大目录）。超限即停止遍历并置 `exhausted`，调用方据此把 `truncated` 置真 ——
 * **宁可给"结果不完整"的明确信号，也不要静默返回半份结果**（后者会被模型误读成"确实没有该符号"，
 * 接着反复换模式重试，把工具预算耗光）。
 */
export interface WalkLimits {
  /** 最大递归深度（搜索根为 0） */
  maxDepth: number;
  /** 单次遍历最多检查的目录项数 */
  maxEntries: number;
  /** 单次遍历的墙钟时间预算（毫秒） */
  timeBudgetMs: number;
}

export const DEFAULT_WALK_LIMITS: WalkLimits = {
  maxDepth: 24,
  maxEntries: 30_000,
  timeBudgetMs: 3_000,
};

/** 一次遍历的共享状态；调用方持有它，遍历结束后读 `exhausted` 判断是否被预算截断。 */
export interface WalkState {
  /** 已进入目录的 canonical（realpath）路径 —— 按它去重，切断 symlink 环 */
  visited: Set<string>;
  /** 已检查的目录项计数 */
  entries: number;
  /** 是否因深度 / 条目 / 时间上限提前中止 */
  exhausted: boolean;
  /** 墙钟截止时刻（由 createWalkState 按预算计算） */
  deadline: number;
}

export function createWalkState(limits: WalkLimits = DEFAULT_WALK_LIMITS): WalkState {
  return { visited: new Set(), entries: 0, exhausted: false, deadline: Date.now() + limits.timeBudgetMs };
}

/**
 * 递归遍历目录下所有文件，惰性产出绝对路径；受 `WalkLimits` 预算约束。
 *
 * 进入每个目录前做 realpath canonical 校验：Windows junction / 符号链接目录可能被 isDirectory()
 * 报告为 true，跟随会逃出搜索根 —— 与 paths.ts 同源的 canonical 护栏必须在此一并拦截。
 * 同一个 canonical 目录只进入一次（`state.visited`），因此 symlink 环不会造成无限递归。
 */
export function* walkFiles(
  dir: string,
  rootCanon: string,
  limits: WalkLimits = DEFAULT_WALK_LIMITS,
  state: WalkState = createWalkState(limits),
  depth = 0
): Generator<string> {
  if (state.exhausted) return;
  if (depth > limits.maxDepth || state.entries >= limits.maxEntries || Date.now() > state.deadline) {
    state.exhausted = true;
    return;
  }

  let real: string;
  try {
    real = fs.realpathSync(dir);
  } catch {
    return;
  }
  if (!isPathInside(rootCanon, real)) return; // 逃逸：拦截
  if (state.visited.has(real)) return; // symlink 环 / 重复路径：同一个目录只进一次
  state.visited.add(real);

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (state.entries >= limits.maxEntries || Date.now() > state.deadline) {
      state.exhausted = true;
      return;
    }
    state.entries++;
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkFiles(full, rootCanon, limits, state, depth + 1);
    else if (e.isFile()) yield full;
  }
}

function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/** 读文件并拆行；二进制 / 超出 maxBytes / 不可读返回 null。 */
function readLines(file: string, maxBytes: number = MAX_GREP_FILE_BYTES): string[] | null {
  let raw: Buffer;
  try {
    if (fs.statSync(file).size > maxBytes) return null;
    raw = fs.readFileSync(file);
  } catch {
    return null;
  }
  if (isBinary(raw)) return null;
  return raw.toString('utf8').split('\n');
}

/**
 * 在指定目录（默认工作区根）递归搜索匹配 pattern 的行，返回「文件:行号:内容」。
 *
 * pattern 按**正则**解析（非法正则回退为字面量），与 grep / ripgrep 语义一致：
 * `a|b|c`、`foo.*bar` 这类模型常用写法一次就能命中，不再被误判成"无匹配"。
 */
export function grepFiles(
  root: string,
  allowedDirs: string[],
  pattern: string,
  opts: { dir?: string; include?: string; maxResults?: number } = {}
): GrepResult {
  const needle = String(pattern ?? '');
  if (!needle) throw new Error('grep 需要非空 pattern');
  if (needle.length > MAX_GREP_PATTERN_LEN) {
    throw new Error(`grep pattern 过长（上限 ${MAX_GREP_PATTERN_LEN} 字符）`);
  }
  const needleRx = compilePattern(needle);
  const base = resolveTarget(root, allowedDirs, opts.dir || root);
  const includeRx = opts.include ? globToRegex(String(opts.include)) : null;
  const maxResults = opts.maxResults ?? MAX_GREP_RESULTS;
  const matches: GrepMatch[] = [];
  let truncated = false;

  const walk = createWalkState();
  for (const file of walkFiles(base, base, DEFAULT_WALK_LIMITS, walk)) {
    if (includeRx && !includeRx.test(path.basename(file))) continue;
    const lines = readLines(file);
    if (lines === null) continue;
    for (let i = 0; i < lines.length; i++) {
      const hit = needleRx ? needleRx.test(lines[i]) : lines[i].includes(needle);
      if (!hit) continue;
      if (matches.length >= maxResults) {
        truncated = true;
        break;
      }
      matches.push({ file, line: i + 1, text: lines[i].slice(0, MAX_GREP_LINE_LEN) });
    }
    if (truncated) break;
  }
  // 遍历被预算截断 → 结果不完整，必须让调用方（模型）看见，而不是静默给半份
  if (walk.exhausted) truncated = true;
  return { matches, truncated, walkExhausted: walk.exhausted };
}

/** 在指定目录（默认工作区根）递归匹配 basename 通配模式的文件，返回绝对路径列表。 */
export function globFiles(
  root: string,
  allowedDirs: string[],
  pattern: string,
  opts: { dir?: string; maxResults?: number } = {}
): GlobResult {
  const pat = String(pattern ?? '');
  if (!pat) throw new Error('glob 需要非空 pattern');
  const base = resolveTarget(root, allowedDirs, opts.dir || root);
  const rx = globToRegex(pat);
  const maxResults = opts.maxResults ?? MAX_GLOB_RESULTS;
  const files: string[] = [];
  let truncated = false;

  const walk = createWalkState();
  for (const file of walkFiles(base, base, DEFAULT_WALK_LIMITS, walk)) {
    if (!rx.test(path.basename(file))) continue;
    if (files.length >= maxResults) {
      truncated = true;
      break;
    }
    files.push(file);
  }
  // 与 grep 同理：被预算截断的遍历属于"结果不完整"，必须显式回报
  if (walk.exhausted) truncated = true;
  return { files, truncated, walkExhausted: walk.exhausted };
}

export function writeTextFile(root: string, allowedDirs: string[], filePath: string, content: string): void {
  const resolved = resolveTarget(root, allowedDirs, filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o755 });
  fs.writeFileSync(resolved, content, { encoding: 'utf8', mode: 0o644 });
}

/**
 * 删除文件（P2-6 会话回滚里"撤销新建"用），仍受 canonical 路径护栏约束。
 *
 * 目标不存在视为成功（ENOENT 吞掉）：回滚可能被点第二次，而"它已经不在那儿了"
 * 与"我们要的结果"一致，不该报成失败让用户以为没回滚干净。
 */
export function deleteFile(root: string, allowedDirs: string[], filePath: string): void {
  const resolved = resolveTarget(root, allowedDirs, filePath);
  try {
    fs.unlinkSync(resolved);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

/** 读取文件旧内容（用于补丁 diff；文件不存在时返回 undefined），仍受 canonical 路径护栏约束。 */
export function tryReadFile(root: string, allowedDirs: string[], filePath: string): string | undefined {
  const resolved = resolveTarget(root, allowedDirs, filePath);
  try {
    return fs.readFileSync(resolved, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * 补丁落地前的乐观并发校验（P0-2）。
 *
 * Agent 在发出 `file.patch.pending` 时对目标文件拍了快照（`oldContent`），但用户可能在
 * 看到 Diff、点「应用」之前的这段窗口里从外部改动了该文件（编辑器保存 / 另一个工具 / 另一个
 * 会话的补丁）。旧实现 accept 后直接 `writeTextFile`，会把那段并发修改**静默覆盖**。
 *
 * 这里以「快照 vs 当前磁盘内容」为乐观锁：不一致即判定为冲突，由调用方拒绝应用并显式回报，
 * 而不是悄悄吞掉用户的改动。文件不存在（undefined）与快照 undefined 视为一致——覆盖语义都
 * 是"从无到有"的新建，不构成冲突。
 *
 * @returns `{ ok: true }` 或 `{ ok: false, conflict: true, currentContent }`
 */
export function checkPatchConflict(
  root: string,
  allowedDirs: string[],
  filePath: string,
  expectedOldContent: string | undefined
): { ok: true } | { ok: false; conflict: true; currentContent: string | undefined } {
  const current = tryReadFile(root, allowedDirs, filePath);
  if (current === expectedOldContent) return { ok: true };
  return { ok: false, conflict: true, currentContent: current };
}

// ---------------------------------------------------------------------------
// 命令策略（默认拒绝）
// ---------------------------------------------------------------------------

export interface CommandPolicy {
  /** 允许的命令前缀白名单；空 = 不额外限制（但内置高危规则仍生效） */
  allowPrefixes?: string[];
  /** 追加的拒绝命令片段（正则） */
  denyPatterns?: RegExp[];
}

/**
 * 内置高危拒绝规则（始终生效，与调用方 denyPatterns 取并集）。
 * 覆盖常见破坏性/危险形态：递归强制删除、fork bomb、磁盘格式化、直接写块设备、
 * curl|sh 管道执行、关机/重启、Windows 磁盘格式化与递归删除。
 */
export const DEFAULT_DENY_PATTERNS: RegExp[] = [
  // rm 递归 + 强制（rm -rf / -fr / -r -f / --recursive --force 等）
  /\brm\s+(-rf|-fr|--recursive|--force|-r\s+-f|-f\s+-r)\b/i,
  // fork bomb
  /:\(\)\s*\{/,
  /:\|\s*;\s*\}/,
  // 磁盘格式化 / 直接写块设备
  /\bmkfs(\.[a-z0-9]+)?\b(\s+[^\s]*)?/i,
  /\bdd\s+if=.*of=\/dev\/(sd|hd|nvme|xvd|disk)/si,
  />\s*\/dev\/(sd|hd|nvme|xvd|disk)/,
  // 关机 / 重启 / 挂起
  /\b(shutdown|reboot|halt|poweroff)\b/i,
  // curl|wget 管道给 shell 执行
  /(curl|wget)[^\r\n|]*\|\s*(ba)?sh\b/i,
  // 显式 eval 执行
  /\beval\s*[({]/i,
  // Windows：format C:、rd /s /q、del /f /s /q
  /\bformat\s+[a-z]:/i,
  /\brd\s+\/s\s+\/q\b/i,
  /\bdel\s+\/f\s+\/s\s+\/q\b/i,
];

export interface CommandDecision {
  allowed: boolean;
  reason?: string;
}

export function evaluateCommandPolicy(command: string, policy: CommandPolicy = {}): CommandDecision {
  const trimmed = (command ?? '').trim();
  if (!trimmed) return { allowed: false, reason: '命令为空' };

  const denyPatterns = [...DEFAULT_DENY_PATTERNS, ...(policy.denyPatterns ?? [])];
  for (const re of denyPatterns) {
    if (re.test(trimmed)) {
      return { allowed: false, reason: `命令命中拒绝规则：${re}` };
    }
  }
  if (policy.allowPrefixes?.length) {
    const matched = policy.allowPrefixes.some((prefix) => trimmed.startsWith(prefix));
    if (!matched) {
      return { allowed: false, reason: `命令不在白名单前缀内（${policy.allowPrefixes.join(', ')}）` };
    }
  }
  return { allowed: true };
}

export interface CommandRunResult {
  ok: boolean;
  output: string;
  durationMs: number;
}

export type CommandRunner = (
  spec: SandboxedCommand,
  timeoutMs: number
) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;

export async function executeCommand(
  command: string,
  cwd: string,
  opts: { timeoutMs?: number; runner?: CommandRunner; sandbox?: CommandSandbox } = {}
): Promise<CommandRunResult> {
  const t0 = Date.now();
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const runner = opts.runner ?? defaultRunner;
  const sandbox = opts.sandbox ?? new ProcessSandbox({ workspaceRoot: cwd });
  try {
    const spec = sandbox.prepare(command, cwd);
    const { exitCode, stdout, stderr } = await runner(spec, timeoutMs);
    const output = [stdout, stderr].filter(Boolean).join('\n').slice(-8000) || '(无输出)';
    return { ok: exitCode === 0, output, durationMs: Date.now() - t0 };
  } catch (e) {
    return { ok: false, output: `命令执行异常：${e instanceof Error ? e.message : String(e)}`, durationMs: Date.now() - t0 };
  }
}

function defaultRunner(spec: SandboxedCommand, timeoutMs: number): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  // 延迟 require 避免测试环境无 child_process 场景也被加载
  const cp = require('child_process') as typeof import('child_process');
  const spawnOpts: import('child_process').SpawnOptions = {
    cwd: spec.cwd,
    env: spec.env,
    windowsHide: true,
    shell: spec.shell,
  };
  // POSIX：detached 使子进程成为进程组组长，便于超时后整组终止
  if (process.platform !== 'win32') spawnOpts.detached = true;

  return new Promise((resolve, reject) => {
    const child = cp.spawn(spec.command, spec.args, spawnOpts);
    let stdout = '';
    let stderr = '';
    // 单流累积上限：防止 fork bomb 等命令的输出撑爆内存
    const MAX_CAPTURE = 1024 * 1024;
    let killed = false;
    let settled = false;

    const timer = setTimeout(() => {
      killed = true;
      killTree(cp, child);
    }, timeoutMs);

    child.stdout?.on('data', (d: Buffer) => {
      if (stdout.length < MAX_CAPTURE) stdout += d.toString().slice(0, MAX_CAPTURE - stdout.length);
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < MAX_CAPTURE) stderr += d.toString().slice(0, MAX_CAPTURE - stderr.length);
    });
    const settle = (fn: () => void) => {
      if (!settled) {
        settled = true;
        fn();
      }
    };
    child.on('error', (err: Error) => {
      clearTimeout(timer);
      settle(() => reject(err));
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      // 超时被杀以传统 timeout 退出码 124 表示
      settle(() => resolve({ exitCode: killed ? 124 : code, stdout, stderr }));
    });
  });
}

/** 终止整棵进程树：Windows 走 taskkill /T /F，POSIX 用负 pid 杀进程组。 */
function killTree(
  cp: typeof import('child_process'),
  child: import('child_process').ChildProcess
): void {
  try {
    if (process.platform === 'win32') {
      if (child.pid) cp.execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else if (child.pid) {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
}