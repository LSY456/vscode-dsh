/**
 * 工作区信任门禁（P0-1）在 DaemonManager 上的落地验证。
 *
 * 这里只钉一件事：**未受信任时 `start()` 必须在读配置之前收手**。
 * 它是唯一会 spawn 子进程的入口（`restart()` 也走它），所以这道门一旦被摘掉，
 * 打开不可信仓库就等于执行任意进程 —— 这正是 P0-1 要堵的洞。
 *
 * 环境说明：本仓库没有 vitest alias 配置，扩展侧模块（import vscode）在这里统一靠
 * `vi.mock('vscode')` 顶掉宿主 API；daemon 侧模块刻意不 import vscode，所以单测能直跑。
 * 用 `vi.hoisted` 而不是普通顶层 const：`vi.mock` 会被提升到 import 之前，
 * 普通 const 在工厂执行时还处于 TDZ。
 */
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  /** getConfiguration 假体：记录被读过的键，便于断言"门禁在读配置之前" */
  const readKeys: string[] = [];
  const configGet = vi.fn((key: string, def: unknown) => {
    readKeys.push(key);
    return def;
  });
  return { readKeys, configGet };
});

vi.mock('vscode', () => ({
  workspace: {
    isTrusted: true,
    workspaceFolders: undefined,
    rootPath: '/repo',
    getConfiguration: () => ({ get: h.configGet }),
    onDidGrantWorkspaceTrust: () => ({ dispose() {} }),
  },
  window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }) },
  commands: { executeCommand: async () => undefined },
}));

import { DaemonManager } from './daemonManager';

/** 每次 start 前清空读数，便于逐次断言。 */
async function startWith(m: DaemonManager) {
  h.readKeys.length = 0;
  h.configGet.mockClear();
  await m.start();
  return h.readKeys.slice();
}

describe('DaemonManager 工作区信任门禁（P0-1）', () => {
  it('未受信任：start() 立刻进入 restricted，且一个配置项都没读', async () => {
    const m = new DaemonManager({ extensionPath: '/ext', isTrusted: () => false });
    const read = await startWith(m);

    expect(m.getStatus().status).toBe('restricted');
    expect(m.getStatus().detail).toContain('信任此工作区');
    // 关键不变式：连 dsh.daemon.command 都没被读到，恶意工作区无从注入要执行的进程
    expect(read).toEqual([]);
  });

  it('未受信任：restart() 同样被拦住（不能靠重启绕过）', async () => {
    const m = new DaemonManager({ extensionPath: '/ext', isTrusted: () => false });
    await m.restart();
    expect(m.getStatus().status).toBe('restricted');
  });

  it('已受信任：越过门禁进入启动流程（开始读配置）', async () => {
    const m = new DaemonManager({ extensionPath: '/ext', isTrusted: () => true });
    const read = await startWith(m);

    expect(m.getStatus().status).not.toBe('restricted');
    expect(read.length).toBeGreaterThan(0);
    expect(read).toContain('daemon.mode');
  });

  it('信任状态在两次 start 之间变化：第二次能正常启动', async () => {
    let trusted = false;
    const m = new DaemonManager({ extensionPath: '/ext', isTrusted: () => trusted });

    await startWith(m);
    expect(m.getStatus().status).toBe('restricted');

    trusted = true; // 模拟用户点了「信任此工作区」
    const read = await startWith(m);
    expect(m.getStatus().status).not.toBe('restricted');
    expect(read).toContain('daemon.mode');
  });

  it('缺省（未注入 isTrusted）：视为已信任，保持裸用/测试可用', async () => {
    const m = new DaemonManager({ extensionPath: '/ext' });
    const read = await startWith(m);

    expect(m.getStatus().status).not.toBe('restricted');
    expect(read).toContain('daemon.mode');
  });
});
