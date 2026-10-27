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
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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

import { DaemonManager, isDshDaemonCommandLine, readProcessCommandLine, splitCommandLine } from './daemonManager';

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

describe('splitCommandLine：解析用户配置的外部 daemon 启动命令', () => {
  it('按空白切分，引号内的空格被保留', () => {
    expect(splitCommandLine('node /a/b.js --port 0')).toEqual(['node', '/a/b.js', '--port', '0']);
    expect(splitCommandLine('"C:\\Program Files\\node.exe" /a/b.js')).toEqual([
      'C:\\Program Files\\node.exe',
      '/a/b.js',
    ]);
  });

  it('反斜杠**不是**转义符（Windows 路径原样保留）', () => {
    // 回归：若把 `\` 当转义符，`"C:\Program Files\app.exe"` 会被吃成 `C:Program Filesapp.exe`
    expect(splitCommandLine('"C:\\Program Files\\app.exe"')).toEqual(['C:\\Program Files\\app.exe']);
    // 未加引号时反斜杠照样不参与解析，只按空白切
    expect(splitCommandLine('C:\\Program Files\\app.exe')).toEqual(['C:\\Program', 'Files\\app.exe']);
  });

  it('单引号同样成对；空参数 `""` 不被丢掉', () => {
    expect(splitCommandLine("node 'a b.js'")).toEqual(['node', 'a b.js']);
    expect(splitCommandLine('node ""')).toEqual(['node', '']);
  });

  it('未闭合引号宽松处理（延续到结尾），不抛错', () => {
    expect(splitCommandLine('node "a b.js')).toEqual(['node', 'a b.js']);
  });

  it('多余空白 / 制表符 / 换行不产生空参数', () => {
    expect(splitCommandLine('  node   \t a.js \n')).toEqual(['node', 'a.js']);
    expect(splitCommandLine('   ')).toEqual([]);
  });
});

describe('isDshDaemonCommandLine：回收陈旧 daemon 前的身份核对', () => {
  const EXT = '/ext';

  it('认出本扩展的内置 daemon（含升级后仍跑在旧目录里的那个）', () => {
    expect(isDshDaemonCommandLine('/usr/bin/node /ext/out/daemon/index.js --port 0', EXT)).toBe(true);
    // 扩展升级后目录名会变（…-0.7.0 → …-0.8.0），而"陈旧 daemon"恰恰跑在旧目录里：
    // 只比完整路径会漏掉它，所以匹配的是入口脚本名
    expect(
      isDshDaemonCommandLine('/usr/bin/node /home/u/.vscode/extensions/pub.dsh-0.7.0/out/daemon/index.js', EXT)
    ).toBe(true);
  });

  it('Windows 反斜杠路径同样识别（大小写与分隔符统一归一化）', () => {
    expect(isDshDaemonCommandLine('node.exe C:\\Ext\\out\\daemon\\index.js', 'C:\\ext')).toBe(true);
  });

  it('无关进程一律不认 —— 这条判断决定"要不要 kill"', () => {
    expect(isDshDaemonCommandLine('/usr/bin/node /home/u/server.js', EXT)).toBe(false);
    expect(isDshDaemonCommandLine('explorer.exe', EXT)).toBe(false);
    expect(isDshDaemonCommandLine('', EXT)).toBe(false);
  });

  it('读不到命令行（undefined）= 身份不明 = 不认（失败关闭）', () => {
    expect(isDshDaemonCommandLine(undefined, EXT)).toBe(false);
  });
});

describe('recycleStaleDaemon：杀进程前先验身份（失败关闭）', () => {
  /** 直接驱动 private 方法：要验的是"kill 与否"的决策本身，不该为此真去 spawn 一个 daemon */
  interface RecycleHost {
    workspaceRoot: string;
    recycleStaleDaemon(): Promise<void>;
  }

  function makeRecycler(probe: (pid: number) => string | undefined, dir: string): RecycleHost {
    const m = new DaemonManager({
      extensionPath: '/ext',
      isTrusted: () => true,
      readProcessCommandLine: probe,
    });
    (m as unknown as RecycleHost).workspaceRoot = dir;
    return m as unknown as RecycleHost;
  }

  function writePortFile(dir: string, pid: number): string {
    const dsh = path.join(dir, '.dsh');
    fs.mkdirSync(dsh, { recursive: true });
    const file = path.join(dsh, 'daemon.json');
    fs.writeFileSync(file, JSON.stringify({ port: 12345, pid }), 'utf8');
    return file;
  }

  function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-recycle-'));
    return fn(dir).finally(() => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });
  }

  it('pid 指向无关进程：只移除端口文件，绝不动手 kill', async () => {
    await withTmpDir(async (dir) => {
      const portFile = writePortFile(dir, 4242);
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
      try {
        await makeRecycler(() => 'C:\\Windows\\explorer.exe', dir).recycleStaleDaemon();
        expect(kill).not.toHaveBeenCalled();
        // 不杀的代价很小：端口文件照样清掉，新 daemon 会在新端口拉起
        expect(fs.existsSync(portFile)).toBe(false);
      } finally {
        kill.mockRestore();
      }
    });
  });

  it('探针读不到命令行（抛错 / 权限不足）：同样不 kill（宁可不杀，不误杀）', async () => {
    await withTmpDir(async (dir) => {
      writePortFile(dir, 4243);
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
      try {
        await makeRecycler(() => {
          throw new Error('EACCES');
        }, dir).recycleStaleDaemon();
        expect(kill).not.toHaveBeenCalled();
      } finally {
        kill.mockRestore();
      }
    });
  });

  it('确认为 dsh daemon 进程：才真的结束它', async () => {
    await withTmpDir(async (dir) => {
      writePortFile(dir, 4244);
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
      try {
        await makeRecycler(() => 'node /ext/out/daemon/index.js --port 0', dir).recycleStaleDaemon();
        expect(kill).toHaveBeenCalledWith(4244);
      } finally {
        kill.mockRestore();
      }
    });
  });

  it('端口文件缺失或损坏：不抛错、不 kill', async () => {
    await withTmpDir(async (dir) => {
      const dsh = path.join(dir, '.dsh');
      fs.mkdirSync(dsh, { recursive: true });
      fs.writeFileSync(path.join(dsh, 'daemon.json'), 'not json', 'utf8');
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
      try {
        await makeRecycler(() => 'node /ext/out/daemon/index.js', dir).recycleStaleDaemon();
        expect(kill).not.toHaveBeenCalled();
      } finally {
        kill.mockRestore();
      }
    });
  });

  it('readProcessCommandLine 的契约：拿不到就返回 undefined，绝不抛错', () => {
    const pid = 0x7fffffff; // 必然不存在
    // 只调用一次，两个断言共用同一个结果。
    // 为什么不能调两次：Windows 分支走 `execFileSync(..., { timeout: 3000 })`
    // （daemonManager.ts:147），单次调用的硬上限就是 3000ms；两次 → 最坏 6000ms，
    // 已经超过 vitest 默认的 5000ms 用例上限，在慢的 CI runner 上必判超时
    // （本机两次实测约 1.6s，windows-latest 上直接撞线）。
    // 一次调用仍覆盖两条契约：抛错时 `not.toThrow()` 失败；不抛错才拿得到返回值。
    let cmd: string | undefined;
    expect(() => {
      cmd = readProcessCommandLine(pid);
    }).not.toThrow();
    expect(cmd).toBeUndefined();
  });
});
