/**
 * Diff 补丁审批（diffProvider）的行为锁。
 *
 * 这里有四条**改了就会静默损坏用户文件**的不变式，正是本文件存在的理由：
 *  1. 补丁视图只有 new 侧可写，且**回执之后一律不可写**（审计记录不能被事后篡改）；
 *  2. 目标文件是脏文档时，**绝不能让 daemon 写盘** —— 否则磁盘与缓冲区就此分叉，
 *     用户下次 Ctrl+S 会用旧缓冲区覆盖掉 Agent 的结果；此时改走编辑器缓冲区（`applyInEditor`）；
 *  3. 脏文档内容与 `oldContent` 对不上（审阅期间又被改过）时**不静默覆盖**，
 *     但仍照常回执，避免 Agent 干等到 TTL 超时；
 *  4. 命令入口的参数既可能是 URI（Diff 标题栏）也可能是裸 patchId（Webview 卡片），
 *     解析错了就是把决策记到另一个补丁上。
 *
 * 环境：`vscode` 由 `vi.mock` 顶掉；假 Uri 只需实现 `scheme / path / query / toString`。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Uri } from 'vscode';

interface FakeUri {
  scheme: string;
  path: string;
  query: string;
  authority: string;
  fsPath: string;
  toString(): string;
}

const h = vi.hoisted(() => {
  const state = {
    /** 记下所有弹给用户的文案，便于断言"拦下来了且说明了原因" */
    messages: [] as Array<{ level: string; text: string }>,
    statusBar: [] as string[],
    /** 被执行的命令（vscode.diff 等） */
    executed: [] as Array<{ command: string; args: unknown[] }>,
    /** 已注册的命令回调 */
    commands: new Map<string, (arg?: unknown) => unknown>(),
    /** 文件系统提供器注册参数 */
    fsRegistrations: [] as Array<{ scheme: string; opts: unknown }>,
    /** WorkspaceEdit 里记录到的替换 */
    edits: [] as Array<{ content: string }>,
    applyEditResult: true,
    textDocuments: [] as unknown[],
    visibleTextEditors: [] as unknown[],
    /** 配置读数 */
    config: { 'diff.autoOpen': true } as Record<string, unknown>,
    subscriptions: [] as Array<{ dispose(): void }>,
  };
  return state;
});

vi.mock('vscode', () => {
  class FakeUriImpl implements FakeUri {
    scheme: string;
    path: string;
    query: string;
    authority: string;
    private raw: string;
    constructor(raw: string, scheme: string, authority: string, path: string, query: string) {
      this.raw = raw;
      this.scheme = scheme;
      this.authority = authority;
      this.path = path;
      this.query = query;
    }
    get fsPath(): string {
      return this.path;
    }
    toString(): string {
      return this.raw;
    }
    static parse(raw: string): FakeUriImpl {
      const m = /^([a-z0-9+.-]+):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?/i.exec(raw);
      const scheme = m ? m[1] : '';
      const authority = m ? m[2] : '';
      const path = m ? m[3] : '';
      const query = m && m[4] ? m[4] : '';
      return new FakeUriImpl(raw, scheme, authority, path, query);
    }
  }

  class FakeEventEmitter {
    private listeners: Array<(e: unknown) => void> = [];
    event = (l: (e: unknown) => void) => {
      this.listeners.push(l);
      return { dispose() {} };
    };
    fire(e: unknown): void {
      this.listeners.forEach((l) => l(e));
    }
    dispose(): void {
      this.listeners.length = 0;
    }
  }

  class FakeWorkspaceEdit {
    replace(_uri: unknown, _range: unknown, content: string): void {
      h.edits.push({ content });
    }
  }

  function noPerm(msg: string): Error {
    const e = new Error(msg) as Error & { code: string };
    e.code = 'NoPermissions';
    return e;
  }
  function notFound(uri: { toString(): string }): Error {
    const e = new Error('FileNotFound: ' + uri.toString()) as Error & { code: string };
    e.code = 'FileNotFound';
    return e;
  }

  return {
    Uri: FakeUriImpl,
    EventEmitter: FakeEventEmitter,
    Disposable: class {
      constructor(private fn?: () => void) {}
      dispose(): void {
        this.fn?.();
      }
    },
    WorkspaceEdit: FakeWorkspaceEdit,
    Range: class {
      constructor(
        readonly start: unknown,
        readonly end: unknown
      ) {}
    },
    FileSystemError: { NoPermissions: noPerm, FileNotFound: notFound },
    FileType: { File: 1, Directory: 2 },
    FileChangeType: { Changed: 2 },
    ViewColumn: { Beside: -2 },
    workspace: {
      registerFileSystemProvider: (scheme: string, _provider: unknown, opts: unknown) => {
        h.fsRegistrations.push({ scheme, opts });
        return { dispose() {} };
      },
      getConfiguration: () => ({
        get: (key: string, def: unknown) => (key in h.config ? h.config[key] : def),
      }),
      applyEdit: async () => h.applyEditResult,
      get textDocuments() {
        return h.textDocuments;
      },
    },
    commands: {
      registerCommand: (id: string, cb: (arg?: unknown) => unknown) => {
        h.commands.set(id, cb);
        return { dispose() {} };
      },
      executeCommand: async (command: string, ...args: unknown[]) => {
        h.executed.push({ command, args });
      },
    },
    window: {
      showWarningMessage: (text: string) => {
        h.messages.push({ level: 'warn', text });
        return Promise.resolve(undefined);
      },
      showErrorMessage: (text: string) => {
        h.messages.push({ level: 'error', text });
        return Promise.resolve(undefined);
      },
      showInformationMessage: (text: string) => {
        h.messages.push({ level: 'info', text });
        return Promise.resolve(undefined);
      },
      setStatusBarMessage: (text: string) => {
        h.statusBar.push(text);
        return { dispose() {} };
      },
      get visibleTextEditors() {
        return h.visibleTextEditors;
      },
    },
  };
});

import { DshDiffManager } from './diffProvider';
import { EventFilePatchPending } from '../shared/protocol';

/** 假的 daemon 客户端：只记录 request 收到的参数。 */
function fakeClient() {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  return {
    calls,
    client: {
      request: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        return {};
      },
    },
  };
}

function pending(id: string, over?: Partial<EventFilePatchPending>): EventFilePatchPending {
  return {
    sessionId: 's1',
    patchId: id,
    path: '/repo/file.txt',
    oldContent: '旧\n',
    newContent: '新\n',
    ...over,
  };
}

/** 造一个目标文件在编辑器里的假文档。 */
function makeDoc(text: string, isDirty: boolean) {
  return {
    uri: { fsPath: '/repo/file.txt', toString: () => 'file:///repo/file.txt' },
    isDirty,
    getText: () => text,
    positionAt: (offset: number) => ({ line: 0, character: offset }),
  };
}

const ctx = { subscriptions: [] as Array<{ dispose(): void }> };

beforeEach(() => {
  h.messages.length = 0;
  h.statusBar.length = 0;
  h.executed.length = 0;
  h.commands.clear();
  h.fsRegistrations.length = 0;
  h.edits.length = 0;
  h.applyEditResult = true;
  h.textDocuments = [];
  h.visibleTextEditors = [];
  h.config = { 'diff.autoOpen': true };
  ctx.subscriptions.length = 0;
});

describe('diffProvider：补丁视图只有 new 侧可写', () => {
  it('new 侧读出提议内容，old 侧读出原始快照（缺省为空串）', async () => {
    const m = new DshDiffManager(() => null);
    m.handlePatchPending(pending('p1'));
    m.handlePatchPending(pending('p2', { oldContent: undefined, newContent: '新建\n' }));
    const newUri = uriFrom(m, 'p1', 'new');
    const oldUri = uriFrom(m, 'p1', 'old');
    const noOld = uriFrom(m, 'p2', 'old');
    expect(m.readFile(newUri).toString()).toBe('新\n');
    expect(m.readFile(oldUri).toString()).toBe('旧\n');
    expect(m.readFile(noOld).toString()).toBe('');
  });

  it('未知补丁：读文件抛 FileNotFound，不返回空内容糊弄调用方', () => {
    const m = new DshDiffManager(() => null);
    expect(() => m.readFile(uriFrom(m, 'ghost', 'new'))).toThrow(/FileNotFound/);
  });

  it('向 old 侧写入一律拒绝（旧内容是审计依据，不能改）', () => {
    const m = new DshDiffManager(() => null);
    m.handlePatchPending(pending('p1'));
    expect(() => m.writeFile(uriFrom(m, 'p1', 'old'), Buffer.from('改'))).toThrow(/不可写/);
  });

  it('回执之后 new 侧也拒绝写入（补丁已处理，视图只读）', () => {
    const m = new DshDiffManager(() => null);
    m.handlePatchPending(pending('p1'));
    m.handlePatchResult({ sessionId: 's1', patchId: 'p1', accepted: true, applied: true });
    expect(() => m.writeFile(uriFrom(m, 'p1', 'new'), Buffer.from('改'))).toThrow(/无法再编辑/);
  });

  it('写入 new 侧后，读回来是用户编辑后的文本（不是 daemon 给的原文）', () => {
    const m = new DshDiffManager(() => null);
    m.handlePatchPending(pending('p1'));
    m.writeFile(uriFrom(m, 'p1', 'new'), Buffer.from('用户改过\n'));
    expect(m.readFile(uriFrom(m, 'p1', 'new')).toString()).toBe('用户改过\n');
  });

  it('同一 patchId 重新下发时清掉旧编辑，回到 daemon 的最新提议', () => {
    const m = new DshDiffManager(() => null);
    m.handlePatchPending(pending('p1'));
    m.writeFile(uriFrom(m, 'p1', 'new'), Buffer.from('用户改过\n'));
    m.handlePatchPending(pending('p1', { newContent: '再提议\n' }));
    expect(m.readFile(uriFrom(m, 'p1', 'new')).toString()).toBe('再提议\n');
  });
});

describe('diffProvider：stat / readDirectory', () => {
  it('根是目录，文件节点大小按 UTF-8 字节算（不是字符数）', () => {
    const m = new DshDiffManager(() => null);
    m.handlePatchPending(pending('p1', { newContent: '中文' }));
    const stat = m.stat(uriFrom(m, 'p1', 'new'));
    expect(stat.type).toBe(1);
    expect(stat.size).toBe(6);
    expect(m.stat(uriFrom(m, '', 'new')).type).toBe(2);
  });

  it('根目录列出全部补丁视图；非根返回空', () => {
    const m = new DshDiffManager(() => null);
    m.handlePatchPending(pending('p1'));
    m.handlePatchPending(pending('p2'));
    expect(m.readDirectory(uriFrom(m, '', 'new')).map((x) => x[0]).sort()).toEqual(['p1.patch', 'p2.patch']);
    expect(m.readDirectory(uriFrom(m, 'p1', 'new'))).toEqual([]);
  });

  it('注册时明确声明 isReadonly: false —— 这是"编辑后应用"能用的前提', () => {
    const m = new DshDiffManager(() => null);
    m.register(ctx as never);
    expect(h.fsRegistrations).toEqual([{ scheme: 'dsh-patch', opts: { isCaseSensitive: true, isReadonly: false } }]);
  });
});

describe('diffProvider：respond 的落盘通路', () => {
  it('daemon 未连接：提示且不发请求', async () => {
    const m = new DshDiffManager(() => null);
    m.handlePatchPending(pending('p1'));
    await m.respond('p1', true);
    expect(h.messages.at(-1)).toEqual({ level: 'error', text: 'daemon 未连接，无法回传补丁决策' });
  });

  it('未知补丁：提示"不存在或已处理"，不发请求', async () => {
    const { calls, client } = fakeClient();
    const m = new DshDiffManager(() => client as never);
    await m.respond('ghost', true);
    expect(h.messages.at(-1)?.text).toContain('补丁不存在或已处理');
    expect(calls).toHaveLength(0);
  });

  it('目标文件不脏：不动编辑器，applyInEditor=false', async () => {
    const { calls, client } = fakeClient();
    const m = new DshDiffManager(() => client as never);
    m.handlePatchPending(pending('p1'));
    h.textDocuments = [makeDoc('旧\n', false)];
    await m.respond('p1', true);
    expect(h.edits).toHaveLength(0);
    expect(calls[0].params).toMatchObject({ patchId: 'p1', accept: true, applyInEditor: false });
  });

  it('目标文件是脏文档且内容等于 oldContent：写进缓冲区并标记 applyInEditor', async () => {
    const { calls, client } = fakeClient();
    const m = new DshDiffManager(() => client as never);
    m.handlePatchPending(pending('p1'));
    h.textDocuments = [makeDoc('旧\n', true)];
    await m.respond('p1', true);
    expect(h.edits).toEqual([{ content: '新\n' }]);
    expect(calls[0].params).toMatchObject({ accept: true, applyInEditor: true });
  });

  it('脏文档内容与 oldContent 不符：不覆盖，但照常回执 applyInEditor=false', async () => {
    const { calls, client } = fakeClient();
    const m = new DshDiffManager(() => client as never);
    m.handlePatchPending(pending('p1'));
    h.textDocuments = [makeDoc('用户自己改的\n', true)];
    await m.respond('p1', true);
    expect(h.edits).toHaveLength(0);
    expect(h.messages.at(-1)?.text).toContain('审阅期间已被修改');
    expect(calls[0].params).toMatchObject({ accept: true, applyInEditor: false });
  });

  it('写编辑器失败：报错并中止，不回执（不能让 daemon 以为改完了）', async () => {
    const { calls, client } = fakeClient();
    const m = new DshDiffManager(() => client as never);
    m.handlePatchPending(pending('p1'));
    h.textDocuments = [makeDoc('旧\n', true)];
    h.applyEditResult = false;
    await m.respond('p1', true);
    expect(h.messages.at(-1)?.level).toBe('error');
    expect(calls).toHaveLength(0);
  });

  it('显式传 content 时以它为准（"编辑后应用"通路）', async () => {
    const { calls, client } = fakeClient();
    const m = new DshDiffManager(() => client as never);
    m.handlePatchPending(pending('p1'));
    h.textDocuments = [makeDoc('旧\n', true)];
    await m.respond('p1', true, '用户最终版\n');
    expect(h.edits).toEqual([{ content: '用户最终版\n' }]);
    expect(calls[0].params.content).toBe('用户最终版\n');
  });

  it('拒绝：哪怕目标是脏文档也不碰缓冲区', async () => {
    const { calls, client } = fakeClient();
    const m = new DshDiffManager(() => client as never);
    m.handlePatchPending(pending('p1'));
    h.textDocuments = [makeDoc('旧\n', true)];
    await m.respond('p1', false);
    expect(h.edits).toHaveLength(0);
    expect(calls[0].params).toMatchObject({ accept: false, applyInEditor: false });
    expect(h.statusBar.at(-1)).toContain('拒绝');
  });
});

describe('diffProvider：applyEdited 的取文本顺序', () => {
  it('优先读 Diff 编辑器里的当前文本（含未保存编辑）', async () => {
    const { calls, client } = fakeClient();
    const m = new DshDiffManager(() => client as never);
    m.handlePatchPending(pending('p1'));
    h.visibleTextEditors = [
      { document: { uri: { toString: () => 'other://x' }, getText: () => '不是这个' } },
      { document: { uri: { toString: () => uriFrom(m, 'p1', 'new').toString() }, getText: () => '编辑器里改的\n' } },
    ];
    await m.applyEdited('p1');
    expect(calls[0].params.content).toBe('编辑器里改的\n');
  });

  it('没有打开的编辑器时回落到 FS 写入缓冲', async () => {
    const { calls, client } = fakeClient();
    const m = new DshDiffManager(() => client as never);
    m.handlePatchPending(pending('p1'));
    m.writeFile(uriFrom(m, 'p1', 'new'), Buffer.from('缓冲里的\n'));
    await m.applyEdited('p1');
    expect(calls[0].params.content).toBe('缓冲里的\n');
  });

  it('两处都没有：提示先打开 Diff，不发请求', async () => {
    const { calls, client } = fakeClient();
    const m = new DshDiffManager(() => client as never);
    m.handlePatchPending(pending('p1'));
    await m.applyEdited('p1');
    expect(h.messages.at(-1)?.text).toContain('请先打开 Diff');
    expect(calls).toHaveLength(0);
  });
});

describe('diffProvider：Diff 打开与命令参数解析', () => {
  it('autoOpen 关闭时不自动打开，但仍登记补丁', async () => {
    h.config = { 'diff.autoOpen': false };
    const m = new DshDiffManager(() => null);
    m.handlePatchPending(pending('p1'));
    expect(h.executed).toHaveLength(0);
    expect(m.readFile(uriFrom(m, 'p1', 'new')).toString()).toBe('新\n');
  });

  it('打开 Diff 用 vscode.diff + 并排视图，标题带文件名', async () => {
    // 关掉自动打开，否则登记那一刻就已经弹过一次，这里数不清是谁触发的
    h.config = { 'diff.autoOpen': false };
    const m = new DshDiffManager(() => null);
    m.handlePatchPending(pending('p1'));
    await m.openDiff('p1');
    expect(h.executed).toHaveLength(1);
    expect(h.executed[0].command).toBe('vscode.diff');
    expect(h.executed[0].args[2]).toBe('dsh 补丁: file.txt');
  });

  it('未知补丁打开 Diff：只提示，不调命令', async () => {
    const m = new DshDiffManager(() => null);
    await m.openDiff('ghost');
    expect(h.executed).toHaveLength(0);
    expect(h.messages.at(-1)?.text).toContain('补丁不存在或已处理');
  });

  it('命令参数为 URI 时取 URI 里的 patchId（Diff 标题栏入口）', async () => {
    const { calls, client } = fakeClient();
    const m = new DshDiffManager(() => client as never);
    m.register(ctx as never);
    m.handlePatchPending(pending('p7'));
    await h.commands.get('dsh.diff.accept')!(uriFrom(m, 'p7', 'new'));
    expect(calls[0].params.patchId).toBe('p7');
  });

  it('命令参数为字符串时按 patchId 处理（Webview 卡片入口）', async () => {
    const { calls, client } = fakeClient();
    const m = new DshDiffManager(() => client as never);
    m.register(ctx as never);
    m.handlePatchPending(pending('p8'));
    await h.commands.get('dsh.diff.reject')!('p8');
    expect(calls[0].params).toMatchObject({ patchId: 'p8', accept: false });
  });

  it('无参调用：恰好一个挂起补丁时自动选中它', async () => {
    const { calls, client } = fakeClient();
    const m = new DshDiffManager(() => client as never);
    m.register(ctx as never);
    m.handlePatchPending(pending('p9'));
    await h.commands.get('dsh.diff.accept')!();
    expect(calls[0].params.patchId).toBe('p9');
  });

  it('无参调用且没有挂起补丁 / 有多个：给提示且不做决策', async () => {
    const { calls, client } = fakeClient();
    const m = new DshDiffManager(() => client as never);
    m.register(ctx as never);
    await h.commands.get('dsh.diff.accept')!();
    expect(h.messages.at(-1)?.text).toContain('没有待审查的补丁');
    m.handlePatchPending(pending('p1'));
    m.handlePatchPending(pending('p2'));
    await h.commands.get('dsh.diff.accept')!();
    expect(h.messages.at(-1)?.text).toContain('存在多个待审查补丁');
    expect(calls).toHaveLength(0);
  });
});

describe('diffProvider：已回执记录只保留最近 20 条', () => {
  it('超过上限时清理最旧的已回执补丁，未回执的不受影响', () => {
    const m = new DshDiffManager(() => null);
    m.handlePatchPending(pending('live'));
    for (let i = 0; i < 21; i++) {
      m.handlePatchPending(pending('p' + i));
      m.handlePatchResult({ sessionId: 's1', patchId: 'p' + i, accepted: true, applied: true });
    }
    // 第 22 次下发触发 prune：已回执的保留最近 20 条 → p0 被清掉
    m.handlePatchPending(pending('p21'));
    expect(() => m.readFile(uriFrom(m, 'p0', 'new'))).toThrow(/FileNotFound/);
    expect(m.readFile(uriFrom(m, 'p20', 'new')).toString()).toBe('新\n');
    expect(m.readFile(uriFrom(m, 'live', 'new')).toString()).toBe('新\n');
  });
});

/**
 * 取某个补丁视图的 Uri —— 走被测类自己的 `makeUri`（私有），
 * 这样测试断言的 URI 形状与生产完全一致，不会因为手写字符串而"自证"。
 */
function uriFrom(m: DshDiffManager, patchId: string, side: 'old' | 'new'): Uri {
  const anyM = m as unknown as { makeUri(id: string, s: 'old' | 'new'): Uri };
  return anyM.makeUri(patchId, side);
}
