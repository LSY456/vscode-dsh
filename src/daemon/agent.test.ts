import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EVENTS, ERROR_CODES } from '../../shared/protocol';
import { AgentContext, runFakeAgent } from './agent';
import { isPathInside } from './paths';
import { SessionSnapshotStore } from './sessionSnapshot';
import { sleep } from './test-utils';

let tmpDir: string;
let sampleFile: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-agent-test-'));
  sampleFile = path.join(tmpDir, 'sample.txt');
  fs.writeFileSync(sampleFile, 'line1\nTODO: fix\nline3\n', 'utf8');
});

afterAll(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

interface MockCtx extends AgentContext {
  events: Array<{ method: string; params: any }>;
  waiters: Array<{ kind: 'approval' | 'patch'; resolve: (v: boolean) => void }>;
}

function makeCtx(overrides?: Partial<AgentContext>): MockCtx {
  const events: Array<{ method: string; params: any }> = [];
  const waiters: Array<{ kind: 'approval' | 'patch'; resolve: (v: boolean) => void }> = [];
  let canceled = false;
  const ctx: MockCtx = {
    sessionId: 's1',
    workspaceRoot: tmpDir,
    capabilities: undefined,
    notify: (method, params) => events.push({ method, params }),
    waitForUser: (kind) =>
      new Promise<boolean>((resolve) => waiters.push({ kind, resolve })),
    isCanceled: () => canceled,
    readFile: async (target) =>
      fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : undefined,
    events,
    waiters,
    ...overrides,
  };
  // 允许测试通过 setCanceled 触发取消
  (ctx as unknown as { setCanceled: () => void }).setCanceled = () => {
    canceled = true;
  };
  return ctx;
}

const waitEvent = async (ctx: MockCtx, method: string, timeoutMs = 3000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = ctx.events.find((e) => e.method === method);
    if (found) return found;
    await sleep(10);
  }
  throw new Error('等待事件超时: ' + method);
};

describe('Agent：文件修改（补丁流程 + 路径护栏）', () => {
  it('工作区内修改 -> pending -> 接受 -> 应用并写盘', async () => {
    const ctx = makeCtx();
    const run = runFakeAgent(ctx, {
      sessionId: 's1',
      prompt: '请修改文件内容，把 TODO 替换为 DONE（write edit）',
      attachments: [{ kind: 'file', path: sampleFile, name: 'sample.txt', content: fs.readFileSync(sampleFile, 'utf8') }],
    });

    await waitEvent(ctx, EVENTS.FilePatchPending);
    expect(ctx.waiters).toHaveLength(1);
    expect(ctx.waiters[0].kind).toBe('patch');
    const pending = ctx.events.find((e) => e.method === EVENTS.FilePatchPending)!;
    expect(pending.params.path).toBe(fs.realpathSync(sampleFile));
    expect(pending.params.newContent).toContain('DONE');

    ctx.waiters[0].resolve(true);
    await run;

    const result = ctx.events.find((e) => e.method === EVENTS.FilePatchResult)!;
    expect(result.params.accepted).toBe(true);
    expect(result.params.applied).toBe(true);
    expect(fs.readFileSync(sampleFile, 'utf8')).toContain('DONE');
    expect(ctx.events.some((e) => e.method === EVENTS.SessionEnded && e.params.reason === 'completed')).toBe(true);
  });

  it('工作区外路径 -> 拒绝：Error 事件且不发起补丁', async () => {
    const outside = path.join(tmpDir, '..', 'outside.txt');
    const ctx = makeCtx();
    const run = runFakeAgent(ctx, {
      sessionId: 's1',
      prompt: `请修改 ${outside}（write edit）`,
    });
    await run;
    const err = ctx.events.find((e) => e.method === EVENTS.Error)!;
    expect(err).toBeTruthy();
    expect(err.params.code).toBe(ERROR_CODES.PathOutsideWorkspace);
    expect(ctx.events.some((e) => e.method === EVENTS.FilePatchPending)).toBe(false);
  });

  it('真实用户场景：只给文件名（请修改 test.txt）-> 解析到工作区内新建', async () => {
    const ctx = makeCtx();
    const run = runFakeAgent(ctx, {
      sessionId: 's1',
      prompt: '请修改 test.txt，把 TODO 替换为 DONE',
    });
    const pending = await waitEvent(ctx, EVENTS.FilePatchPending);
    expect(ctx.waiters[0].kind).toBe('patch');
    // 真实语义断言：目标必须是工作区内的 test.txt（不依赖 canonical 大小写形态）
    expect(isPathInside(tmpDir, pending.params.path)).toBe(true);
    expect(path.basename(pending.params.path)).toBe('test.txt');
    expect(pending.params.oldContent).toBeUndefined(); // 文件不存在 => 新建分支

    ctx.waiters[0].resolve(true);
    await run;

    const created = path.join(tmpDir, 'test.txt');
    expect(fs.existsSync(created)).toBe(true);
    expect(fs.readFileSync(created, 'utf8')).toContain('edited by dsh mock agent');
  });

  it('相对路径含目录（components/App.tsx）-> 解析到工作区内', async () => {
    const ctx = makeCtx();
    const run = runFakeAgent(ctx, {
      sessionId: 's1',
      prompt: '请修改 components/App.tsx，把 TODO 替换为 DONE',
    });
    const pending = await waitEvent(ctx, EVENTS.FilePatchPending);
    expect(isPathInside(tmpDir, pending.params.path)).toBe(true);
    expect(path.basename(pending.params.path)).toBe('App.tsx');
    expect(path.dirname(pending.params.path).split(path.sep).pop()).toBe('components');

    ctx.waiters[0].resolve(false); // 拒绝即可，不写盘
    await run;
    expect(fs.existsSync(path.join(tmpDir, 'components', 'App.tsx'))).toBe(false);
  });

  it('无路径可解析时兜底到工作区内 output.txt（而不是进程启动目录）', async () => {
    const ctx = makeCtx();
    const run = runFakeAgent(ctx, {
      sessionId: 's1',
      prompt: '请修改文件内容，把 TODO 替换为 DONE',
    });
    const pending = await waitEvent(ctx, EVENTS.FilePatchPending);
    expect(isPathInside(tmpDir, pending.params.path)).toBe(true);
    expect(path.basename(pending.params.path)).toBe('output.txt');
    // 显式断言指向工作区根（修复前指向 daemon 进程启动目录）
    expect(path.dirname(pending.params.path)).not.toContain('Microsoft VS Code');

    ctx.waiters[0].resolve(false);
    await run;
  });

  it('P2 编辑后应用：accept 时优先写用户编辑后内容（而非 agent 原始提议）', async () => {
    // 独立文件，避免污染共享 sampleFile（后续「按需读取」用例依赖其原始 line1 内容）
    const ownFile = path.join(tmpDir, 'edited-apply.txt');
    fs.writeFileSync(ownFile, 'TODO: original\n', 'utf8');
    const edited = '用户编辑后的最终内容（部分采纳）\n';
    const ctx = makeCtx({ getPatchContent: () => edited });
    const run = runFakeAgent(ctx, {
      sessionId: 's1',
      prompt: '请修改文件内容，把 TODO 替换为 DONE（write edit）',
      attachments: [{ kind: 'file', path: ownFile, name: 'edited-apply.txt', content: fs.readFileSync(ownFile, 'utf8') }],
    });

    await waitEvent(ctx, EVENTS.FilePatchPending);
    ctx.waiters[0].resolve(true);
    await run;

    // 真实场景：落盘的应是用户编辑后的内容，而非 mock 默认 newContent（含签名 banner）
    const written = fs.readFileSync(ownFile, 'utf8');
    expect(written).toBe(edited);
    expect(written).not.toContain('edited by dsh mock agent');
  });
});

describe('Agent：高危工具审批与能力禁用', () => {
  it('bash 且允许 -> approval.request -> 批准 -> tool.executed ok', async () => {
    const ctx = makeCtx();
    const run = runFakeAgent(ctx, { sessionId: 's1', prompt: '危险操作：bash rm -rf（danger）' });
    await waitEvent(ctx, EVENTS.ApprovalRequest);
    expect(ctx.waiters).toHaveLength(1);
    expect(ctx.waiters[0].kind).toBe('approval');
    const approval = ctx.events.find((e) => e.method === EVENTS.ApprovalRequest)!;
    expect(approval.params.tool).toBe('bash_execute');
    expect(approval.params.risk).toBe('high');

    ctx.waiters[0].resolve(true);
    await run;
    const tool = ctx.events.find((e) => e.method === EVENTS.ToolExecuted && e.params.tool === 'bash_execute')!;
    expect(tool.params.ok).toBe(true);
  });

  it('bash 被 allowedTools 禁用（白名单不含）-> 不发起审批，tool.executed ok:false', async () => {
    const ctx = makeCtx({ capabilities: { allowedTools: ['read_file'] } });
    const run = runFakeAgent(ctx, { sessionId: 's1', prompt: '危险操作：bash rm -rf（danger）' });
    await run;
    expect(ctx.events.some((e) => e.method === EVENTS.ApprovalRequest)).toBe(false);
    const tool = ctx.events.find((e) => e.method === EVENTS.ToolExecuted && e.params.tool === 'bash_execute')!;
    expect(tool.params.ok).toBe(false);
    expect(tool.params.output).toContain('禁用');
  });

  it('allowedTools 为空/缺省 = 全部允许', async () => {
    const ctx = makeCtx({ capabilities: { allowedTools: [] } });
    const run = runFakeAgent(ctx, { sessionId: 's1', prompt: '危险操作：bash rm -rf（danger）' });
    await waitEvent(ctx, EVENTS.ApprovalRequest);
    ctx.waiters[0].resolve(false);
    await run;
    const tool = ctx.events.find((e) => e.method === EVENTS.ToolExecuted && e.params.tool === 'bash_execute')!;
    expect(tool.params.ok).toBe(false); // 拒绝而非禁用
    expect(tool.params.output).toContain('拒绝');
  });

  it('B1 信任记忆：命中白名单的 bash 免审批直接执行（不发起 approval.request）', async () => {
    const ctx = makeCtx({ isTrusted: (cmd) => cmd === 'rm -rf build/ && npm run build' });
    const run = runFakeAgent(ctx, { sessionId: 's1', prompt: 'bash 执行构建（bash）' });
    await run;
    // 核心断言：免审批（零 approval.request、零挂起），且 tool.executed 标记 trusted
    expect(ctx.events.some((e) => e.method === EVENTS.ApprovalRequest)).toBe(false);
    expect(ctx.waiters).toHaveLength(0);
    const tool = ctx.events.find((e) => e.method === EVENTS.ToolExecuted && e.params.tool === 'bash_execute')!;
    expect(tool.params.ok).toBe(true);
    expect(tool.params.trusted).toBe(true);
  });

  it('B1 安全分层：allowedTools 禁用优先于信任放行（不因记住命令而绕过门禁）', async () => {
    const ctx = makeCtx({
      isTrusted: () => true, // 即便命中信任，仍须尊重工具白名单
      capabilities: { allowedTools: ['read_file'] },
    });
    const run = runFakeAgent(ctx, { sessionId: 's1', prompt: '危险操作：bash rm -rf（danger）' });
    await run;
    expect(ctx.events.some((e) => e.method === EVENTS.ApprovalRequest)).toBe(false);
    const tool = ctx.events.find((e) => e.method === EVENTS.ToolExecuted && e.params.tool === 'bash_execute')!;
    expect(tool.params.ok).toBe(false);
    expect(tool.params.output).toContain('禁用');
    expect(tool.params.trusted).toBeUndefined();
  });
});

describe('Agent：取消与按需读取', () => {
  it('slow 流程中取消 -> session.ended(canceled)', async () => {
    const ctx = makeCtx();
    const run = runFakeAgent(ctx, { sessionId: 's1', prompt: 'slow 输出测试（slow）' });
    await waitEvent(ctx, EVENTS.MessageDelta, 5000); // slow 循环的首个点
    (ctx as unknown as { setCanceled: () => void }).setCanceled();
    await run;
    const ended = ctx.events.find((e) => e.method === EVENTS.SessionEnded)!;
    expect(ended.params.reason).toBe('canceled');
  });

  it('contentOmitted 附件 -> 经 readFile 按需读取', async () => {
    const ctx = makeCtx();
    const run = runFakeAgent(ctx, {
      sessionId: 's1',
      prompt: '请查看文件内容（read）',
      attachments: [{ kind: 'file', path: sampleFile, name: 'sample.txt', contentOmitted: true }],
    });
    await run;
    const tool = ctx.events.find((e) => e.method === EVENTS.ToolExecuted && e.params.tool === 'read_file')!;
    expect(tool.params.ok).toBe(true);
    expect(tool.params.output).toContain('line1');
  });
});

/**
 * P2-6 端到端：Agent 改文件 → 影子快照 → 一键回滚。
 *
 * 这条链路的价值全在**装配**上（两个零件各有自己的单测）：快照钩子有没有真的从
 * AgentContext 接到落地裁决上。钩子挂错位置（比如挂到了"用户拒绝"的分支、或忘了在写盘
 * 之前调），单测照样全绿，而回滚一个文件都还不了 —— 只有跑一遍完整流程才看得出来。
 */
describe('Agent × P2-6：改动之后能回滚', () => {
  it('接受补丁后，影子快照能把文件还原到本次会话开始前', async () => {
    const target = path.join(tmpDir, 'rollback-me.txt');
    fs.writeFileSync(target, 'line1\nTODO: fix\nline3\n', 'utf8');

    const store = new SessionSnapshotStore({
      root: path.join(tmpDir, '.dsh', 'snapshots'),
      workspaceRoot: tmpDir,
      log: () => {},
    });
    const ctx = makeCtx({ recordSnapshot: (p, c) => store.record('s1', p, c) });
    const run = runFakeAgent(ctx, {
      sessionId: 's1',
      prompt: '请修改文件，把 TODO 替换为 DONE（write edit）',
      attachments: [
        { kind: 'file', path: target, name: 'rollback-me.txt', content: fs.readFileSync(target, 'utf8') },
      ],
    });

    await waitEvent(ctx, EVENTS.FilePatchPending);
    ctx.waiters.shift()!.resolve(true);
    await run;

    // 改动确实落盘了（否则下面"回滚成功"就毫无意义）
    expect(fs.readFileSync(target, 'utf8')).not.toContain('TODO');
    expect(store.count('s1')).toBe(1);

    const report = store.restore('s1', () => false);
    expect(report.restored).toHaveLength(1);
    expect(fs.readFileSync(target, 'utf8')).toBe('line1\nTODO: fix\nline3\n');
  });

  it('用户拒绝补丁 -> 什么都没改，快照里也不该多出条目', async () => {
    const target = path.join(tmpDir, 'rejected.txt');
    fs.writeFileSync(target, 'line1\nTODO: fix\nline3\n', 'utf8');

    const store = new SessionSnapshotStore({
      root: path.join(tmpDir, '.dsh', 'snapshots'),
      workspaceRoot: tmpDir,
      log: () => {},
    });
    const ctx = makeCtx({
      sessionId: 's2',
      recordSnapshot: (p, c) => store.record('s2', p, c),
    });
    const run = runFakeAgent(ctx, {
      sessionId: 's2',
      prompt: '请修改文件，把 TODO 替换为 DONE（write edit）',
      attachments: [{ kind: 'file', path: target, name: 'rejected.txt', content: fs.readFileSync(target, 'utf8') }],
    });

    await waitEvent(ctx, EVENTS.FilePatchPending);
    ctx.waiters.shift()!.resolve(false);
    await run;

    expect(fs.readFileSync(target, 'utf8')).toContain('TODO');
    expect(store.count('s2')).toBe(0);
  });
});
