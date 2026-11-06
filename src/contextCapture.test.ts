/**
 * 主动上下文捕获（contextCapture）的行为锁。
 *
 * 这个模块决定"Agent 一睁眼看到什么"，四类口径错了用户都无从察觉：
 *  1. 大文件必须省略正文并打 `contentOmitted` —— 否则一个几 MB 的日志文件直接把请求顶爆；
 *  2. 选区行号是 1-based（VSCode 是 0-based），错一位就是把"第 3 行"报成"第 2 行"；
 *  3. 诊断要限量（单文件 + 工作区摘要各有一道上限），否则满屏红波浪线的仓库会撑爆 payload；
 *  4. git status 是"锦上添花"：开关关闭、没有工作区、命令失败、无输出 —— 四种情况都必须
 *     **静默跳过**，绝不能因为 git 不在 PATH 就让整次发送失败。
 *
 * 环境说明：`vscode` 用 `vi.mock` 顶掉（本仓库没有 vitest alias 配置），
 * `child_process.execFile` 同样用假体，测试不依赖本机是否装 git。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeDiag {
  severity: number;
  message: string;
  source?: unknown;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
}

const h = vi.hoisted(() => {
  const state = {
    /** 可被子用例改写的配置读数 */
    config: { 'context.maxFileBytes': 200_000, 'context.gitStatus': true } as Record<string, unknown>,
    folders: [{ uri: { fsPath: '/repo' } }] as Array<{ uri: { fsPath: string } }> | undefined,
    editor: null as unknown,
    fileDiags: [] as FakeDiag[],
    /** 工作区诊断：Map 形状与真实 API 一致（键为 uri 字符串，值为诊断数组） */
    wsDiags: new Map<string, FakeDiag[]>(),
    /** git 假体的行为分支 */
    git: 'ok' as 'ok' | 'error' | 'empty' | 'no-workspace',
    execCalls: [] as Array<{ file: string; args: string[] }>,
  };
  return state;
});

vi.mock('vscode', () => {
  const SEVERITY = { Error: 0, Warning: 1, Information: 2, Hint: 3 };
  return {
    DiagnosticSeverity: SEVERITY,
    window: {
      get activeTextEditor() {
        return h.editor;
      },
    },
    workspace: {
      get workspaceFolders() {
        return h.folders;
      },
      getConfiguration: () => ({
        get: (key: string, def: unknown) => (key in h.config ? h.config[key] : def),
      }),
    },
    languages: {
      getDiagnostics: (uri?: { toString(): string }) => {
        if (uri) return h.fileDiags;
        return h.wsDiags;
      },
    },
  };
});

vi.mock('child_process', () => ({
  execFile: (
    file: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, stdout?: string) => void
  ) => {
    h.execCalls.push({ file, args });
    // 回调异步触发：真实 execFile 不会同步回调，这里保持同形以免测试掩盖时序差
    setImmediate(() => {
      if (h.git === 'ok') cb(null, '## main\n M a.ts\n');
      else if (h.git === 'empty') cb(null, '');
      else cb(new Error('git 不存在'));
    });
    return { on() {}, kill() {} };
  },
}));

import { captureContext } from './contextCapture';
import { Attachment } from '../shared/protocol';

/** 造一个最小可用的编辑器假体：只实现 captureContext 真正读到的字段。 */
function makeEditor(text: string, opts?: { selStart?: number; selEnd?: number; selectionText?: string }) {
  const selStart = opts?.selStart ?? 0;
  const selEnd = opts?.selEnd ?? 0;
  return {
    document: {
      uri: { toString: () => 'file:///repo/src/a.ts', fsPath: '/repo/src/a.ts' },
      languageId: 'typescript',
      getText: (range?: unknown) => (range ? (opts?.selectionText ?? '') : text),
    },
    selection: {
      isEmpty: selStart === selEnd,
      start: { line: selStart },
      end: { line: selEnd },
    },
  };
}

function diag(severity: number, message = 'm', line = 0): FakeDiag {
  return {
    severity,
    message,
    source: 'ts',
    range: { start: { line, character: 0 }, end: { line, character: 4 } },
  };
}

beforeEach(() => {
  h.config = { 'context.maxFileBytes': 200_000, 'context.gitStatus': true };
  h.folders = [{ uri: { fsPath: '/repo' } }];
  h.editor = null;
  h.fileDiags = [];
  h.wsDiags = new Map();
  h.git = 'ok';
  h.execCalls.length = 0;
});

describe('contextCapture：活动编辑器', () => {
  it('正常大小的文件：带上全文、语言、绝对路径与文件名', async () => {
    h.editor = makeEditor('const a = 1;');
    h.config['context.gitStatus'] = false;
    const list = await captureContext();
    const file = list.find((a) => a.kind === 'file') as Attachment;
    expect(file.content).toBe('const a = 1;');
    expect(file.path).toBe('/repo/src/a.ts');
    expect(file.language).toBe('typescript');
    expect(file.name).toBe('a.ts');
    expect(file.contentOmitted).toBeUndefined();
  });

  it('超过 maxFileBytes：只给元信息 + contentOmitted，正文一个字都不带', async () => {
    h.editor = makeEditor('x'.repeat(50));
    h.config['context.gitStatus'] = false;
    // 阈值走 opts 覆盖（配置读数的缺省值仍是 200_000，这里故意用更小的值验证判据本身）
    const list = await captureContext({ maxFileBytes: 10 });
    const file = list.find((a) => a.kind === 'file') as Attachment;
    expect(file.contentOmitted).toBe(true);
    expect(file.content).toBeUndefined();
    expect(file.name).toBe('a.ts');
  });

  it('非空选区：额外产出 selection 附件，行号 1-based', async () => {
    h.editor = makeEditor('l0\nl1\nl2\nl3', { selStart: 1, selEnd: 2, selectionText: 'l1\nl2' });
    h.config['context.gitStatus'] = false;
    const list = await captureContext();
    const sel = list.find((a) => a.kind === 'selection') as Attachment;
    expect(sel.content).toBe('l1\nl2');
    expect(sel.range).toEqual({ startLine: 2, endLine: 3 });
  });

  it('空选区：不产出 selection 附件', async () => {
    h.editor = makeEditor('x');
    h.config['context.gitStatus'] = false;
    const list = await captureContext();
    expect(list.some((a) => a.kind === 'selection')).toBe(false);
  });

  it('没有活动编辑器：既不产出 file 也不产出 selection', async () => {
    h.config['context.gitStatus'] = false;
    const list = await captureContext();
    expect(list.filter((a) => a.kind === 'file' || a.kind === 'selection')).toHaveLength(0);
  });
});

describe('contextCapture：诊断', () => {
  it('四档严重度映射到协议词汇，行列号 +1，source 非字符串时置空', async () => {
    h.editor = makeEditor('x');
    h.config['context.gitStatus'] = false;
    const noSource = diag(0, '无来源');
    noSource.source = undefined;
    h.fileDiags = [diag(0), diag(1), diag(2), diag(3), noSource];
    const list = await captureContext();
    const d = list.find((a) => a.kind === 'diagnostics') as Attachment;
    expect(d.diagnostics?.map((x) => x.severity)).toEqual(['error', 'warning', 'info', 'hint', 'error']);
    expect(d.diagnostics?.[0].range).toEqual({ startLine: 1, startCol: 1, endLine: 1, endCol: 5 });
    expect(d.diagnostics?.[4].source).toBeUndefined();
  });

  it('单文件诊断按 maxDiagnostics 截断，且文件名进附件名', async () => {
    h.editor = makeEditor('x');
    h.config['context.gitStatus'] = false;
    h.fileDiags = Array.from({ length: 8 }, (_, i) => diag(0, 'e' + i));
    const list = await captureContext({ maxDiagnostics: 3 });
    const d = list.find((a) => a.kind === 'diagnostics') as Attachment;
    expect(d.diagnostics).toHaveLength(3);
    expect(d.diagnostics?.map((x) => x.message)).toEqual(['e0', 'e1', 'e2']);
    expect(d.name).toBe('诊断（a.ts）');
  });

  it('工作区摘要：每个有诊断的文件一条统计 + 至多 3 条错误明细', async () => {
    h.config['context.gitStatus'] = false;
    h.wsDiags.set('file:///repo/b.ts', [diag(0, 'e1'), diag(0, 'e2'), diag(0, 'e3'), diag(0, 'e4'), diag(1)]);
    const list = await captureContext();
    const d = list.find((a) => a.kind === 'diagnostics') as Attachment;
    // 1 条统计 + 前 3 条错误；第 4 条错误与那条警告不单独展开
    expect(d.diagnostics).toHaveLength(4);
    expect(d.diagnostics?.[0]).toMatchObject({ source: 'workspace-summary', message: '5 条诊断（4 错误 / 1 警告）' });
    expect(d.diagnostics?.slice(1).map((x) => x.message)).toEqual(['e1', 'e2', 'e3']);
  });

  it('无诊断的文件进不了摘要（避免一行行"0 条诊断"占位）', async () => {
    h.config['context.gitStatus'] = false;
    h.wsDiags.set('file:///repo/clean.ts', []);
    const list = await captureContext();
    expect(list.some((a) => a.kind === 'diagnostics')).toBe(false);
  });

  it('工作区摘要总量有硬上限：每文件最多 4 条、累计到 60 即停（实测上界 63）', async () => {
    h.config['context.gitStatus'] = false;
    for (let i = 0; i < 40; i++) {
      h.wsDiags.set('file:///repo/f' + i + '.ts', [diag(0, 'a'), diag(0, 'b'), diag(0, 'c')]);
    }
    const list = await captureContext();
    const d = list.find((a) => a.kind === 'diagnostics') as Attachment;
    const n = d.diagnostics?.length ?? 0;
    // 判据写在每轮 push 之后，所以最多冲到 60 + 单文件最多 4 条 - 1
    expect(n).toBeGreaterThanOrEqual(60);
    expect(n).toBeLessThanOrEqual(63);
  });
});

describe('contextCapture：git status 一律静默失败', () => {
  it('开关关闭：完全不调用 git', async () => {
    h.config['context.gitStatus'] = false;
    await captureContext();
    expect(h.execCalls).toHaveLength(0);
  });

  it('有工作区时以 -C <root> 运行，输出 trim 后作为 gitStatus 附件', async () => {
    const list = await captureContext();
    expect(h.execCalls).toHaveLength(1);
    expect(h.execCalls[0].file).toBe('git');
    expect(h.execCalls[0].args).toEqual(['-C', '/repo', 'status', '--short', '--branch']);
    const g = list.find((a) => a.kind === 'gitStatus') as Attachment;
    expect(g.gitStatus).toBe('## main\n M a.ts');
  });

  it('没有打开文件夹：不调用 git，也不产出 gitStatus（不猜目录）', async () => {
    h.folders = undefined;
    const list = await captureContext();
    expect(h.execCalls).toHaveLength(0);
    expect(list.some((a) => a.kind === 'gitStatus')).toBe(false);
  });

  it('git 执行失败：跳过附件，不影响其余内容', async () => {
    h.git = 'error';
    h.editor = makeEditor('const a = 1;');
    const list = await captureContext();
    expect(list.some((a) => a.kind === 'gitStatus')).toBe(false);
    expect(list.some((a) => a.kind === 'file')).toBe(true);
  });

  it('git 输出为空：同样跳过附件', async () => {
    h.git = 'empty';
    const list = await captureContext();
    expect(list.some((a) => a.kind === 'gitStatus')).toBe(false);
  });
});
