import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EVENTS, ERROR_CODES } from '../../shared/protocol';
import { AgentContext, runFakeAgent } from './agent';
import { isPathInside } from './paths';
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
