/**
 * 路径护栏（P1.3 / 企业级加固）。
 *
 * 原则：不信任 "词法" 路径 —— path.resolve 只折叠 `..`，但**不解析符号链接/目录联结**。
 * 工作区内的 symlink / Windows junction 可以指向工作区外，词法比对会误判放行，
 * 随后 readFile/writeFile 会跟随链接读写工作区外文件（路径穿越）。
 *
 * 因此本模块一律以 `fs.realpathSync`（canonicalize）作为最终裁判：
 *  - 已存在目标：realpath 完整解析（含父级 symlink/junction、Windows 8.3 短名）
 *  - 尚不存在的写入目标：从最近存在的祖先 realpath 后拼接剩余段
 * 并显式拒绝 NUL 字符与 Windows 备用数据流（ADS，`file.txt:stream`）。
 */
import * as fs from 'fs';
import * as path from 'path';

/** 路径校验失败（携带协议错误码 -32012）。 */
export class PathError extends Error {
  code = -32012;
}

/** 归一化：绝对化 + 平台相关大小写处理（Windows 忽略大小写）。 */
function normalize(p: string): string {
  let resolved = path.resolve(p);
  if (process.platform === 'win32') {
    resolved = resolved.toLowerCase();
  }
  return resolved;
}

/** 词法判断 target 是否位于 root 内（含 root 自身）。仅作廉价预检，不防符号链接。 */
export function isPathInside(root: string, target: string): boolean {
  const r = normalize(root);
  const t = normalize(target);
  if (t === r) return true;
  return t.startsWith(r + path.sep);
}

/** 对已存在路径做 canonicalize；解析失败抛 PathError。 */
export function canonicalize(p: string): string {
  try {
    return fs.realpathSync(path.resolve(p));
  } catch (e) {
    throw new PathError(`无法解析路径: ${p}（${e instanceof Error ? e.message : String(e)}）`);
  }
}

/** 拒绝非法/可疑路径形态（NUL、Windows ADS）。 */
function rejectSuspicious(abs: string): void {
  if (abs.includes('\0')) {
    throw new PathError('路径包含非法字符（NUL）');
  }
  if (process.platform === 'win32') {
    // Windows 正常盘符形如 "C:\..."（冒号位于 index 1，且全局仅此一个冒号）。
    // 出现第二个冒号即视为备用数据流 "file:stream"。
    const firstColon = abs.indexOf(':');
    const lastColon = abs.lastIndexOf(':');
    if (firstColon === 1 && lastColon > 1) {
      throw new PathError('路径包含 Windows 备用数据流（ADS），已拒绝');
    }
  }
}

/**
 * 对读取或写入目标做 canonical 解析：
 *  - 已存在：realpath 完整解析
 *  - 不存在（写入新文件）：解析最近存在的祖先目录后拼接剩余段
 */
export function canonicalizeTarget(target: string): string {
  const abs = path.resolve(target);
  rejectSuspicious(abs);
  if (fs.existsSync(abs)) {
    return canonicalize(abs);
  }
  let prefix = abs;
  let suffix = '';
  while (!fs.existsSync(prefix)) {
    const parent = path.dirname(prefix);
    if (parent === prefix) break; // 已到文件系统根
    suffix = suffix ? path.join(path.basename(prefix), suffix) : path.basename(prefix);
    prefix = parent;
  }
  const canon = canonicalize(prefix);
  return suffix ? path.join(canon, suffix) : canon;
}

/**
 * 校验 target 位于 root 内（canonical 判定），返回解析后的规范绝对路径；
 * 越界抛 PathError(-32012)。
 */
export function assertPathInside(root: string, target: string): string {
  const rootCanon = canonicalize(root);
  const targetCanon = canonicalizeTarget(target);
  if (!isPathInside(rootCanon, targetCanon)) {
    throw new PathError(`路径越界：${target} 不在工作区 ${root} 内`);
  }
  return targetCanon;
}