/**
 * 版本号**唯一来源是 `package.json`**：构建时由 esbuild 注入（见 `esbuild.js` 的 `define`）。
 *
 * 为什么改成注入而不是手写值 —— 这个常量此前是一份手写 semver，于是它和 `package.json`
 * 各自漂移到了「`package.json` = 0.8.0 / 本文件 = 0.3.0」。而它会被 daemon 上报为
 * `daemonVersion`，直接显示在状态行上（「已连接 daemon v0.3.0」）—— 用户可见，且差了 5 个小版本。
 * 手写值天然会腐坏：删掉手写路径本身，让版本号在物理上只存在一份。
 *
 * 直接跑源码时（vitest / ts-node）没有注入，回落到占位符：`typeof` 是唯一对**未声明标识符**
 * 安全的运算符，因此这里不会抛 `ReferenceError`。占位符刻意不写真实版本号 ——
 * 否则它又会成为"第二份真相"，重演本次修的这个缺陷。
 */
declare const __DSH_PKG_VERSION__: string | undefined;

/** 未注入时的占位符（源码直跑）；刻意不是合法发布号。 */
export const FALLBACK_VERSION = '0.0.0-dev';

export const VSD_DSH_VERSION: string =
  typeof __DSH_PKG_VERSION__ === 'string' && __DSH_PKG_VERSION__ ? __DSH_PKG_VERSION__ : FALLBACK_VERSION;
