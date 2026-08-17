/**
 * 真实工具沙箱（P3.3）。
 *
 * 提供只读文件导航（list/read）与受护栏的写入，以及受策略门控的高危命令执行。
 * 所有路径操作都以 isPathInside 做护栏（工作区 ∩ allowedDirs），越界抛 PathError（-32012）。
 *
 * 命令执行采用"策略优先"：evaluateCommandPolicy 为纯函数（可单测），实际执行
 * 通过可注入的 runner 完成，默认走 child_process（daemon 运行期）。
 */
import * as fs from 'fs';
import * as path from 'path';
import { isPathInside } from './paths';

export class PathError extends Error {
  code = -32012;
}

/**
 * 将 target 解析为绝对路径并校验其位于工作区（且若声明则位于 allowedDirs）内。
 * 返回解析后的绝对路径；越界抛 PathError。
 */
export function resolveTarget(root: string, allowedDirs: string[], target: string): string {
  if (!target || typeof target !== 'string') {
    throw new Error('缺少目标路径');
  }
  const resolved = path.resolve(target);
  if (!isPathInside(root, resolved)) {
    throw new PathError(`路径越界：${target} 不在工作区 ${root} 内`);
  }
  if (allowedDirs.length > 0 && !allowedDirs.some((d) => isPathInside(d, resolved))) {
    throw new PathError(`路径越界：${target} 不在 allowedDirs 内`);
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
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, content, 'utf8');
}

/** 读取文件旧内容（用于补丁 diff；文件不存在时返回 undefined），仍受路径护栏约束。 */
export function tryReadFile(root: string, allowedDirs: string[], filePath: string): string | undefined {
  const resolved = resolveTarget(root, allowedDirs, filePath);
  try {
    return fs.readFileSync(resolved, 'utf8');
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 命令策略
// ---------------------------------------------------------------------------

export interface CommandPolicy {
  /** 允许的命令前缀白名单；空 = 全部允许 */
  allowPrefixes?: string[];
  /** 无条件拒绝的命令片段（正则） */
  denyPatterns?: RegExp[];
}

export interface CommandDecision {
  allowed: boolean;
  reason?: string;
}

export function evaluateCommandPolicy(command: string, policy: CommandPolicy): CommandDecision {
  const trimmed = (command ?? '').trim();
  if (!trimmed) return { allowed: false, reason: '命令为空' };

  if (policy.denyPatterns?.length) {
    for (const re of policy.denyPatterns) {
      if (re.test(trimmed)) {
        return { allowed: false, reason: `命令命中拒绝规则：${re}` };
      }
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
  // 平台 shim：用宽松签名规避 exec 多重重载的编码/回调类型分歧
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