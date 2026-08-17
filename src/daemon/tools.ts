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
import { assertPathInside, PathError } from './paths';

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

export function listDirectory(root: string, allowedDirs: string[], dirPath: string): ListResult {
  const resolved = resolveTarget(root, allowedDirs, dirPath);
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
  command: string,
  cwd: string,
  timeoutMs: number
) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;

export async function executeCommand(
  command: string,
  cwd: string,
  opts: { timeoutMs?: number; runner?: CommandRunner } = {}
): Promise<CommandRunResult> {
  const t0 = Date.now();
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const runner = opts.runner ?? defaultRunner;
  try {
    const { exitCode, stdout, stderr } = await runner(command, cwd, timeoutMs);
    const output = [stdout, stderr].filter(Boolean).join('\n').slice(-8000) || '(无输出)';
    return { ok: exitCode === 0, output, durationMs: Date.now() - t0 };
  } catch (e) {
    return { ok: false, output: `命令执行异常：${e instanceof Error ? e.message : String(e)}`, durationMs: Date.now() - t0 };
  }
}

function defaultRunner(command: string, cwd: string, timeoutMs: number): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  // 延迟 require 避免测试环境无 child_process 场景也被加载
  const cp = require('child_process') as typeof import('child_process');
  const exec = cp.exec as unknown as (
    cmd: string,
    opts: Record<string, unknown>,
    cb: (error: { code?: number | string; message?: string } | null, stdout: string, stderr: string) => void
  ) => unknown;
  return new Promise((resolve, reject) => {
    exec(
      command,
      { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') {
          reject(new Error(error.message ?? '命令执行失败'));
          return;
        }
        const exitCode = error && typeof error.code === 'number' ? error.code : 0;
        resolve({ exitCode: exitCode || 0, stdout: String(stdout), stderr: String(stderr) });
      }
    );
  });
}