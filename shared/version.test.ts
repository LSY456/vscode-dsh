import { describe, expect, it } from 'vitest';
import { FALLBACK_VERSION, VSD_DSH_VERSION } from './version';

/**
 * 版本号单一来源的守卫（回归）。
 *
 * 真实事故：`shared/version.ts` 曾手写 `VSD_DSH_VERSION = '0.3.0'`，而 `package.json` 已经
 * 走到 0.8.0。该常量被 daemon 上报为 `daemonVersion`，直接显示在状态行上
 * （「已连接 daemon v0.3.0」）—— 用户可见，且全套测试没有一个发现。
 *
 * 现在版本号只在 `package.json` 里存在一份，构建时注入（见 esbuild.js 的 define）。
 * 源码直跑（本文件就是）没有注入，因此**只要有人再往源码里写死版本号，这两个断言立刻会红**。
 */
describe('版本号单一来源：shared/version.ts 不得再硬编码 semver', () => {
  it('源码路径下取占位符 —— 硬编码值一旦回归，此处即失败', () => {
    expect(VSD_DSH_VERSION).toBe(FALLBACK_VERSION);
  });

  it('占位符刻意不是合法发布号，避免自己变成"第二份真相"', () => {
    expect(FALLBACK_VERSION).toBe('0.0.0-dev');
  });
});
