/**
 * 扩展入口（extension.activate）的装配与两处真实逻辑。
 *
 * 装配代码通常被当成"不值得测"，但这里有两类东西一改就出问题、而类型检查抓不到：
 *  1. **声明与实现的一致性**：`package.json` 里 `contributes.commands` 承诺了哪些命令，
 *     `activate` 就必须真的注册哪些 —— 少一个，用户点下去是"命令不存在"，
 *     而且只有装到真机上才会发现；
 *  2. **状态栏的三态**：正常连接、受限模式（未信任工作区）、信任恢复。受限模式是
 *     "缺一个前置条件"，文案必须给**动作**（去信任）而不是把内部枚举 `restricted` 丢给用户，
 *     点击目标也必须是信任入口；信任恢复后还要把颜色与命令收回去。
 * 另外 `dsh.sendSelection` 的提示词拼装是纯逻辑，也一并锁住。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

interface FakeStatusBar {
  text?: string;
  tooltip?: string;
  command?: string;
  backgroundColor?: { id: string };
  shown: number;
  disposed: number;
}

const h = vi.hoisted(() => {
  const state = {
    /** 命令 id -> 回调 */
    commands: new Map<string, (arg?: unknown) => unknown>(),
    statusBars: [] as FakeStatusBar[],
    messages: [] as Array<{ level: string; text: string }>,
    /** DaemonManager 假体的实例记录 */
    daemons: [] as Array<{
      opts: Record<string, unknown>;
      startCount: number;
      restartCount: number;
      disposed: number;
      status: { status: string; detail: string };
      onStatusCb?: (info: { status: string; detail: string }) => void;
      configAccessor?: unknown;
    }>,
    panels: [] as Array<{ sentPrompts: string[]; revealed: number; trustNotices: number }>,
    diffs: [] as Array<{ registered: number }>,
    dirty: [] as Array<{ disposed: number }>,
    trustHandlers: [] as Array<() => void>,
    isTrusted: true,
    /** 当前活动编辑器（sendSelection 读它） */
    editor: null as unknown,
    progressCalls: [] as unknown[],
  };
  return state;
});

vi.mock('vscode', () => ({
  StatusBarAlignment: { Left: 1 },
  ProgressLocation: { Notification: 15 },
  ConfigurationTarget: { Global: 1 },
  ThemeColor: class {
    id: string;
    constructor(id: string) {
      this.id = id;
    }
  },
  window: {
    createStatusBarItem: () => {
      const bar: FakeStatusBar = { shown: 0, disposed: 0 };
      h.statusBars.push(bar);
      return {
        get text() {
          return bar.text;
        },
        set text(v: string | undefined) {
          bar.text = v;
        },
        get tooltip() {
          return bar.tooltip;
        },
        set tooltip(v: string | undefined) {
          bar.tooltip = v;
        },
        get command() {
          return bar.command;
        },
        set command(v: string | undefined) {
          bar.command = v;
        },
        get backgroundColor() {
          return bar.backgroundColor;
        },
        set backgroundColor(v: { id: string } | undefined) {
          bar.backgroundColor = v;
        },
        show() {
          bar.shown++;
        },
        dispose() {
          bar.disposed++;
        },
      };
    },
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    showInformationMessage: (text: string) => {
      h.messages.push({ level: 'info', text });
      return Promise.resolve(undefined);
    },
    showErrorMessage: (text: string) => {
      h.messages.push({ level: 'error', text });
      return Promise.resolve(undefined);
    },
    withProgress: async (_opts: unknown, task: () => Promise<unknown>) => {
      h.progressCalls.push(_opts);
      return task();
    },
    get activeTextEditor() {
      return h.editor;
    },
  },
  workspace: {
    get isTrusted() {
      return h.isTrusted;
    },
    getConfiguration: () => ({
      get: (_key: string, def: unknown) => def,
      update: async () => undefined,
    }),
    onDidGrantWorkspaceTrust: (fn: () => void) => {
      h.trustHandlers.push(fn);
      return { dispose() {} };
    },
  },
  commands: {
    registerCommand: (id: string, cb: (arg?: unknown) => unknown) => {
      h.commands.set(id, cb);
      return { dispose() {} };
    },
    registerTextEditorCommand: (id: string, cb: (arg?: unknown) => unknown) => {
      h.commands.set(id, cb);
      return { dispose() {} };
    },
  },
}));

vi.mock('./daemonManager', () => ({
  DaemonManager: class {
    private rec: (typeof h.daemons)[number];
    constructor(opts: Record<string, unknown>) {
      this.rec = {
        opts,
        startCount: 0,
        restartCount: 0,
        disposed: 0,
        status: { status: 'stopped', detail: '' },
      };
      h.daemons.push(this.rec);
    }
    get client() {
      return null;
    }
    get configAccessor() {
      return this.rec.configAccessor;
    }
    start() {
      this.rec.startCount++;
    }
    async restart() {
      this.rec.restartCount++;
    }
    getStatus() {
      return this.rec.status;
    }
    onStatus(cb: (info: { status: string; detail: string }) => void) {
      this.rec.onStatusCb = cb;
    }
    dispose() {
      this.rec.disposed++;
    }
  },
}));

vi.mock('./webviewPanel', () => ({
  WebviewPanelHost: class {
    private rec = { sentPrompts: [] as string[], revealed: 0, trustNotices: 0 };
    constructor() {
      h.panels.push(this.rec);
    }
    register() {}
    reveal() {
      this.rec.revealed++;
    }
    createOrShowEditorPanel() {}
    async newSession() {}
    async rollbackSession() {}
    notifyTrustChange() {
      this.rec.trustNotices++;
    }
    async sendPrompt(text: string) {
      this.rec.sentPrompts.push(text);
    }
  },
}));

vi.mock('./diffProvider', () => ({
  DshDiffManager: class {
    private rec = { registered: 0 };
    constructor() {
      h.diffs.push(this.rec);
    }
    register(ctx: { subscriptions: unknown[] }) {
      this.rec.registered++;
      // 真实的注册逻辑有自己的单测（diffProvider.test.ts）；这里只把 4 个 Diff 命令
      // 登记进同一张表，让"声明 vs 实现"的断言看得到全貌
      for (const id of ['dsh.diff.open', 'dsh.diff.accept', 'dsh.diff.reject', 'dsh.diff.applyEdited']) {
        h.commands.set(id, () => undefined);
      }
      ctx.subscriptions.push({ dispose() {} });
    }
    handlePatchPending() {}
    handlePatchResult() {}
  },
}));

vi.mock('./dirtyTracker', () => ({
  DirtyTracker: class {
    private rec = { disposed: 0 };
    constructor() {
      h.dirty.push(this.rec);
    }
    dispose() {
      this.rec.disposed++;
    }
  },
}));

vi.mock('./contextCapture', () => ({ captureContext: async () => [] }));

import { activate, deactivate } from './extension';

/** 每个用例都重新 activate 一遍：装配逻辑本身就是被测对象。 */
function activateWith(trusted: boolean) {
  h.isTrusted = trusted;
  const subscriptions: Array<{ dispose(): void }> = [];
  const context = {
    subscriptions,
    extensionPath: '/ext',
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
    },
  };
  const api = activate(context as never);
  return { api, context };
}

/** package.json 里声明给用户看的所有命令 id —— 装配代码必须一条不落地注册。 */
function declaredCommands(): string[] {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const list = (pkg.contributes?.commands ?? []) as Array<{ command: string }>;
  return list.map((c) => c.command);
}

beforeEach(() => {
  h.commands.clear();
  h.statusBars.length = 0;
  h.messages.length = 0;
  h.daemons.length = 0;
  h.panels.length = 0;
  h.diffs.length = 0;
  h.dirty.length = 0;
  h.trustHandlers.length = 0;
  h.isTrusted = true;
  h.editor = null;
  h.progressCalls.length = 0;
  deactivate();
});

describe('extension：激活装配', () => {
  it('package.json 声明的每个命令都真的被注册（声明与实现不许漂移）', () => {
    activateWith(true);
    const missing = declaredCommands().filter((id) => !h.commands.has(id));
    expect(missing).toEqual([]);
  });

  it('激活即启动 daemon 一次，并把实例作为 exports 暴露给集成测试', () => {
    const { api } = activateWith(true);
    expect(h.daemons[0].startCount).toBe(1);
    expect(api.daemon).toBeTruthy();
    expect(api.diff).toBeTruthy();
    expect(api.panel).toBeTruthy();
  });

  it('启动时就把"是否可信"的判据交给 DaemonManager（门禁不能在扩展侧旁路）', () => {
    activateWith(false);
    const opts = h.daemons[0].opts;
    expect(typeof opts.isTrusted).toBe('function');
    expect((opts.isTrusted as () => boolean)()).toBe(false);
  });

  it('deactivate 会回收 daemon 实例（否则退出后子进程残留）', () => {
    activateWith(true);
    deactivate();
    expect(h.daemons[0].disposed).toBe(1);
  });
});

describe('extension：状态栏三态', () => {
  function statusBar() {
    return h.statusBars.at(-1)!;
  }

  it('已连接：文案给中文字面，原始枚举留在 tooltip 里', () => {
    activateWith(true);
    h.daemons[0].onStatusCb!({ status: 'connected', detail: '127.0.0.1:1' });
    expect(statusBar().text).toContain('dsh: ');
    expect(statusBar().text).toContain('$(circle-filled)');
    expect(statusBar().tooltip).toContain('connected');
    expect(statusBar().command).toBe('dsh.openPanel');
    expect(statusBar().shown).toBeGreaterThan(0);
  });

  it('未受信任：给动作而不是内部枚举，点击进信任入口并带警示色', () => {
    activateWith(false);
    h.daemons[0].onStatusCb!({ status: 'restricted', detail: '工作区未受信任' });
    expect(statusBar().text).toBe('$(lock) dsh: 需要信任此工作区');
    expect(statusBar().command).toBe('dsh.trustWorkspace');
    expect(statusBar().backgroundColor).toEqual({ id: 'statusBarItem.warningBackground' });
  });

  it('信任恢复：颜色与命令收回去（文本交回给状态回调维护）', () => {
    activateWith(false);
    h.daemons[0].onStatusCb!({ status: 'restricted', detail: 'x' });
    h.isTrusted = true;
    for (const fn of h.trustHandlers) fn();
    expect(statusBar().backgroundColor).toBeUndefined();
    expect(statusBar().command).toBe('dsh.openPanel');
    // 信任之后必须真的把 daemon 拉起来：否则用户信任完还得手动重启窗口
    expect(h.daemons[0].startCount).toBe(2);
    expect(h.panels[0].trustNotices).toBe(1);
  });
});

describe('extension：dsh.sendSelection 的提示词', () => {
  async function runSend(editor: unknown) {
    activateWith(true);
    h.editor = editor;
    await h.commands.get('dsh.sendSelection')!();
    return h.panels[0].sentPrompts.at(-1) as string;
  }

  it('无活动编辑器：退回通用分析请求', async () => {
    expect(await runSend(null)).toBe('请分析当前文件并给出建议。');
  });

  it('有选区：把选中代码与语言一起带上', async () => {
    const prompt = await runSend({
      selection: { isEmpty: false },
      document: { languageId: 'typescript', getText: () => 'const a = 1;', uri: { fsPath: '/repo/a.ts' } },
    });
    expect(prompt).toContain('请分析以下选中代码（typescript）');
    expect(prompt).toContain('const a = 1;');
  });

  it('无选区：退化为"分析这个文件"，并给出绝对路径', async () => {
    const prompt = await runSend({
      selection: { isEmpty: true },
      document: { languageId: 'python', getText: () => '', uri: { fsPath: '/repo/a.py' } },
    });
    expect(prompt).toContain('/repo/a.py');
    expect(prompt).toContain('python');
  });
});
