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
 * 读取文件的指定行号范围（1-based 含），返回带行号的内容，供 grep 定位后精读。
 * 单次最多 maxLines 行（缺省 200）；二进制 / 超大 / 越界走 readLines 与 resolveTarget 护栏。
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
}

export interface GlobResult {
  files: string[];
  truncated: boolean;
}

const SKIP_DIRS = new Set(['.git', 'node_modules']);
const MAX_GREP_RESULTS = 200;
const MAX_GLOB_RESULTS = 200;
const MAX_GREP_LINE_LEN = 200;
const MAX_GREP_FILE_BYTES = 1024 * 1024;
/** 行号范围读取的独立大小上限（grep 之外，允许精读更大的单个文件）。 */
const MAX_RANGE_FILE_BYTES = 16 * 1024 * 1024;

/** `*` 通配 → 正则（匹配 basename：`*` 匹配任意字符序列，其余字符转义）。 */
function globToRegex(pattern: string): RegExp {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('^' + pattern.split('*').map(escape).join('.*') + '$');
}

/**
 * 递归遍历目录下所有文件，惰性产出绝对路径。
 * 进入每个目录前做 realpath canonical 校验：Windows junction / 符号链接目录可能被 isDirectory()
 * 报告为 true，跟随会逃出搜索根 —— 与 paths.ts 同源的 canonical 护栏必须在此一并拦截。
 */
function* walkFiles(dir: string, rootCanon: string): Generator<string> {
  let real: string;
  try {
    real = fs.realpathSync(dir);
  } catch {
    return;
  }
  if (!isPathInside(rootCanon, real)) return; // 逃逸：拦截

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkFiles(full, rootCanon);
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

/** 在指定目录（默认工作区根）递归搜索包含 pattern 的行，返回「文件:行号:内容」。 */
export function grepFiles(
  root: string,
  allowedDirs: string[],
  pattern: string,
  opts: { dir?: string; include?: string; maxResults?: number } = {}
): GrepResult {
  const needle = String(pattern ?? '');
  if (!needle) throw new Error('grep 需要非空 pattern');
  const base = resolveTarget(root, allowedDirs, opts.dir || root);
  const includeRx = opts.include ? globToRegex(String(opts.include)) : null;
  const maxResults = opts.maxResults ?? MAX_GREP_RESULTS;
  const matches: GrepMatch[] = [];
  let truncated = false;

  for (const file of walkFiles(base, base)) {
    if (includeRx && !includeRx.test(path.basename(file))) continue;
    const lines = readLines(file);
    if (lines === null) continue;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes(needle)) continue;
      if (matches.length >= maxResults) {
        truncated = true;
        break;
      }
      matches.push({ file, line: i + 1, text: lines[i].slice(0, MAX_GREP_LINE_LEN) });
    }
    if (truncated) break;
  }
  return { matches, truncated };
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

  for (const file of walkFiles(base, base)) {
    if (!rx.test(path.basename(file))) continue;
    if (files.length >= maxResults) {
      truncated = true;
      break;
    }
    files.push(file);
  }
  return { files, truncated };
}

export function writeTextFile(root: string, allowedDirs: string[], filePath: string, content: string): void {
  const resolved = resolveTarget(root, allowedDirs, filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o755 });
  fs.writeFileSync(resolved, content, { encoding: 'utf8', mode: 0o644 });
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