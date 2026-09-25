/**
 * DaemonManager 的两道前置门禁（P0-1 工作区信任、P0-2 无文件夹）验证。
 *
 * 要钉住的核心不变式：**拦下来的时候，一个配置项都还没被读**。
 * 这两道门之所以是 P0：`start()` 是唯一会 spawn 子进程的入口（`restart()` 也走它），
 * 而"要执行的命令"来自配置项 `dsh.daemon.command` —— 门开在配置之前，恶意/异常的工作区
 * 才无从注入；门开在配置之后，就只是个提示而已。
 *
 * 环境说明：本仓库没有 vitest alias 配置，扩展侧模块（import vscode）在这里统一靠
 * `vi.mock('vscode')` 顶掉宿主 API；daemon 侧模块刻意不 import vscode，所以单测能直跑。
 * 用 `vi.hoisted` 而不是普通顶层 const：`vi.mock` 会被提升到 import 之前，
 * 普通 const 在工厂执行时还处于 TDZ。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  /** getConfiguration 假体：记录被读过的键，便于断言"门禁在读配置之前" */
  const readKeys: string[] = [];
  const configGet = vi.fn((key: string, def: unknown) => {
    readKeys.push(key);
    return def;
  });
  /** 工作区形状可切换：undefined = 没打开文件夹（P0-2 场景） */
  const state: { folders: Array<{ uri: { fsPath: string } }> | undefined } = {
    folders: [{ uri: { fsPath: '/repo' } }],
  };
  return { readKeys, configGet, state };
});

vi.mock('vscode', () => ({
  workspace: {
    isTrusted: true,
    get workspaceFolders() {
      return h.state.folders;
    },
    getConfiguration: () => ({ get: h.configGet }),
    onDidGrantWorkspaceTrust: () => ({ dispose() {} }),
  },
  window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }) },
  commands: { executeCommand: async () => undefined },
}));

import { DaemonManager } from './daemonManager';

const ONE_FOLDER = [{ uri: { fsPath: '/repo' } }];

/** 每次 start 前清空读数，便于逐次断言"配置有没有被读到"。 */
async function startWith(m: DaemonManager) {
  h.readKeys.length = 0;
  h.configGet.mockClear();
  await m.start();
  return h.readKeys.slice();
}

function makeManager(isTrusted?: () => boolean) {
  return new DaemonManager({ extensionPath: '/ext', isTrusted });
}

beforeEach(() => {
  h.state.folders = ONE_FOLDER;
});

describe('DaemonManager：工作区信任门禁（P0-1）', () => {
  it('未受信任：start() 立刻进入 restricted，且一个配置项都没读', async () => {
    const m = makeManager(() => false);
    const read = await startWith(m);

    expect(m.getStatus().status).toBe('restricted');
    expect(m.getStatus().detail).toContain('信任此工作区');
    // 关键不变式：连 dsh.daemon.command 都没被读到，恶意工作区无从注入要执行的进程
    expect(read).toEqual([]);
  });

  it('未受信任：restart() 同样被拦住（不能靠重启绕过）', async () => {
    const m = makeManager(() => false);
    await m.restart();
    expect(m.getStatus().status).toBe('restricted');
  });

  it('已受信任：越过门禁进入启动流程（开始读配置）', async () => {
    const m = makeManager(() => true);
    const read = await startWith(m);

    expect(m.getStatus().status).not.toBe('restricted');
    expect(read).toContain('daemon.mode');
  });

  it('信任状态在两次 start 之间变化：第二次能正常启动', async () => {
    let trusted = false;
    const m = makeManager(() => trusted);

    await startWith(m);
    expect(m.getStatus().status).toBe('restricted');

    trusted = true; // 模拟用户点了「信任此工作区」
    const read = await startWith(m);
    expect(m.getStatus().status).not.toBe('restricted');
    expect(read).toContain('daemon.mode');
  });

  it('缺省（未注入 isTrusted）：视为已信任，保持裸用/测试可用', async () => {
    const m = makeManager();
    const read = await startWith(m);

    expect(m.getStatus().status).not.toBe('restricted');
    expect(read).toContain('daemon.mode');
  });
});

describe('DaemonManager：无工作区门禁（P0-2）', () => {
  it('已受信任但没打开文件夹：disabled + 明确指引，且不猜根、不读配置', async () => {
    h.state.folders = undefined;
    const m = makeManager(() => true);
    const read = await startWith(m);

    expect(m.getStatus().status).toBe('disabled');
    expect(m.getStatus().detail).toContain('打开文件夹');
    // 旧实现会回落 process.cwd() 并照常去读配置、拉起 daemon —— 那就是"工作区跑偏"的来源
    expect(read).toEqual([]);
  });

  it('空文件夹数组（打开了空窗口）与 undefined 同等对待', async () => {
    h.state.folders = [];
    const m = makeManager(() => true);
    await startWith(m);
    expect(m.getStatus().status).toBe('disabled');
  });

  it('未受信任 + 没打开文件夹：信任门优先（安全 > 可用性）', async () => {
    h.state.folders = undefined;
    const m = makeManager(() => false);
    await startWith(m);
    expect(m.getStatus().status).toBe('restricted');
  });

  it('先无文件夹被拦，后打开文件夹即可正常启动', async () => {
    h.state.folders = undefined;
    const m = makeManager(() => true);
    await startWith(m);
    expect(m.getStatus().status).toBe('disabled');

    h.state.folders = ONE_FOLDER; // 模拟用户「打开文件夹」
    const read = await startWith(m);
    expect(m.getStatus().status).not.toBe('disabled');
    expect(read).toContain('daemon.mode');
  });
});
