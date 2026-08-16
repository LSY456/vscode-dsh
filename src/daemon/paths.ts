/**
 * 路径护栏（P1.3）：Agent 读写目标必须位于工作区（或 allowedDirs）内。
 */
import * as path from 'path';

/** 判断 target 是否位于 root 目录内（含 root 自身），防 `..` 逃逸与同级前缀误判。 */
export function isPathInside(root: string, target: string): boolean {
  const r = normalize(root);
  const t = normalize(target);
  if (t === r) return true;
  return t.startsWith(r + path.sep);
}

/** 归一化：绝对化 + 平台相关大小写处理（Windows 忽略大小写）。 */
function normalize(p: string): string {
  let resolved = path.resolve(p);
  if (process.platform === 'win32') {
    resolved = resolved.toLowerCase();
  }
  return resolved;
}

/** 校验 target 位于 root 内，否则抛出带协议错误码的异常。 */
export function assertPathInside(root: string, target: string): void {
  if (!isPathInside(root, target)) {
    const err = new Error(`路径越界：${target} 不在工作区 ${root} 内`);
    (err as Error & { code?: number }).code = -32012;
    throw err;
  }
}
