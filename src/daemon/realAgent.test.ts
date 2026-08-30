import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EVENTS, ERROR_CODES } from '../../shared/protocol';
import { AgentCapabilities, AgentContext } from './agent';
import { ChatMessage, ChatModel, FakeChatModel, FakeTurn } from './model';
import { RealAgentConfig, runRealAgent } from './realAgent';

let root = '';
let file = '';
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-realagent-'));
  file = path.join(root, 'a.txt');
  fs.writeFileSync(file, 'TODO\nline2\n', 'utf8');
});
afterAll(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

interface MockCtx extends AgentContext {
  events: Array<{ method: string; params: any }>;
  waiters: Array<{ kind: 'approval' | 'patch'; resolve: (v: boolean) => void }>;
  setCanceled(): void;
}

function makeCtx(caps?: AgentCapabilities): MockCtx {
  const events: Array<{ method: string; params: any }> = [];
  const waiters: Array<{ kind: 'approval' | 'patch'; resolve: (v: boolean) => void }> = [];
  let canceled = false;
  const ctx: MockCtx = {
    sessionId: 's1',
    workspaceRoot: root,
    capabilities: caps,
    notify: (method, params) => events.push({ method, params }),
    waitForUser: (kind) =>
      new Promise<boolean>((resolve) => waiters.push({ kind, resolve })),
    isCanceled: () => canceled,
    readFile: async (target) =>
      fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : undefined,
    events,
    waiters,
    setCanceled: () => {
      canceled = true;
    },
  };
  return ctx;
}

function scripted(turns: FakeTurn[], chunkSize = 4): ChatModel {
  const queue = [...turns];
  return new FakeChatModel(() => queue.shift() ?? { content: '(无更多脚本回复)' }, chunkSize);
}

async function waitEvent(ctx: MockCtx, method: string, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = ctx.events.find((e) => e.method === method);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('等待事件超时: ' + method);
}

const baseParams = { prompt: '测试', attachments: [{ kind: 'file' as const, path: file, name: 'a.txt' }] };

describe('realAgent：只读工具', () => {
  it('read_file 工具：护栏内读取并投影 tool.executed', async () => {
    const ctx = makeCtx();
    const model = scripted([
      { reasoning: '读文件', toolcall: { tool: 'read_file', input: { path: file } } },
      { content: '读取完成' },
    ]);
    await runRealAgent(ctx, baseParams, { model });

    const te = ctx.events.find((e) => e.method === EVENTS.ToolExecuted && e.params.tool === 'read_file')!;
    expect(te.params.ok).toBe(true);
    expect(te.params.output).toContain('TODO');
    expect(ctx.events.some((e) => e.method === EVENTS.SessionEnded && e.params.reason === 'completed')).toBe(true);
    // 推理与正文均投影为对应事件
    expect(ctx.events.some((e) => e.method === EVENTS.ReasoningDelta)).toBe(true);
    expect(ctx.events.some((e) => e.method === EVENTS.MessageDelta)).toBe(true);
  });

  it('read_file 越界：tool.executed ok=false 且不读内容', async () => {
    const ctx = makeCtx();
    const outside = path.join(root, '..', 'secret.txt');
    const model = scripted([
      { toolcall: { tool: 'read_file', input: { path: outside } } },
      { content: 'done' },
    ]);
    await runRealAgent(ctx, baseParams, { model });
    const te = ctx.events.find((e) => e.method === EVENTS.ToolExecuted && e.params.tool === 'read_file')!;
    expect(te.params.ok).toBe(false);
  });
});

describe('realAgent：写入（补丁审批）', () => {
  it('write_file 接受 -> 落盘 + patch.result applied', async () => {
    const ctx = makeCtx();
    const model = scripted([
      { toolcall: { tool: 'write_file', input: { path: file, content: 'NEW-CONTENT\n' } } },
      { content: '写完了' },
    ]);
    const run = runRealAgent(ctx, baseParams, { model });

    await waitEvent(ctx, EVENTS.FilePatchPending);
    const pending = ctx.events.find((e) => e.method === EVENTS.FilePatchPending)!;
    expect(pending.params.newContent).toBe('NEW-CONTENT\n');
    ctx.waiters[0].resolve(true);
    await run;

    expect(fs.readFileSync(file, 'utf8')).toBe('NEW-CONTENT\n');
    const pr = ctx.events.find((e) => e.method === EVENTS.FilePatchResult)!;
    expect(pr.params.accepted && pr.params.applied).toBe(true);
  });

  it('write_file 拒绝 -> 不落盘', async () => {
    const before = fs.readFileSync(file, 'utf8');
    const ctx = makeCtx();
    const model = scripted([
      { toolcall: { tool: 'write_file', input: { path: file, content: 'SHOULD-NOT-WRITE' } } },
      { content: 'done' },
    ]);
    const run = runRealAgent(ctx, baseParams, { model });
    await waitEvent(ctx, EVENTS.FilePatchPending);
    ctx.waiters[0].resolve(false);
    await run;
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('apply_patch：search/replace 生效', async () => {
    const ctx = makeCtx();
    const p = path.join(root, 'b.txt');
    fs.writeFileSync(p, 'AAA-BBB-CCC', 'utf8');
    const model = scripted([
      { toolcall: { tool: 'apply_patch', input: { path: p, search: 'BBB', replace: 'XXX' } } },
      { content: 'done' },
    ]);
    const run = runRealAgent(ctx, { prompt: 'x', attachments: [{ kind: 'file', path: p }] }, { model });
    await waitEvent(ctx, EVENTS.FilePatchPending);
    ctx.waiters[0].resolve(true);
    await run;
    expect(fs.readFileSync(p, 'utf8')).toBe('AAA-XXX-CCC');
  });

  it('write_file 越界 -> Error(-32012)，不发起补丁', async () => {
    const outside = path.join(root, '..', 'outside.txt');
    const ctx = makeCtx();
    const model = scripted([
      { toolcall: { tool: 'write_file', input: { path: outside, content: 'x' } } },
      { content: 'done' },
    ]);
    await runRealAgent(ctx, baseParams, { model });
    const err = ctx.events.find((e) => e.method === EVENTS.Error)!;
    expect(err.params.code).toBe(ERROR_CODES.PathOutsideWorkspace);
    expect(ctx.events.some((e) => e.method === EVENTS.FilePatchPending)).toBe(false);
  });

  it('write_file 被 allowedTools 禁用 -> tool.executed ok=false，不发起补丁', async () => {
    const ctx = makeCtx({ allowedTools: ['read_file'] });
    const model = scripted([
      { toolcall: { tool: 'write_file', input: { path: file, content: 'x' } } },
      { content: 'done' },
    ]);
    await runRealAgent(ctx, baseParams, { model });
    const te = ctx.events.find((e) => e.method === EVENTS.ToolExecuted && e.params.tool === 'write_file')!;
    expect(te.params.ok).toBe(false);
    expect(te.params.output).toContain('禁用');
    expect(ctx.events.some((e) => e.method === EVENTS.FilePatchPending)).toBe(false);
  });
});

describe('realAgent：高危命令', () => {
  it('bash_execute 被允许 -> 审批 -> 批准后执行（注入 runner）', async () => {
    const ctx = makeCtx();
    const model = scripted([
      { toolcall: { tool: 'bash_execute', input: { command: 'npm run build' } } },
      { content: '构建完成' },
    ]);
    const run = runRealAgent(ctx, baseParams, {
      model,
      commandRunner: async () => ({ exitCode: 0, stdout: 'built ok', stderr: '' }),
    });
    await waitEvent(ctx, EVENTS.ApprovalRequest);
    const approval = ctx.events.find((e) => e.method === EVENTS.ApprovalRequest)!;
    expect(approval.params.tool).toBe('bash_execute');
    ctx.waiters[0].resolve(true);
    await run;
    const te = ctx.events.find((e) => e.method === EVENTS.ToolExecuted && e.params.tool === 'bash_execute')!;
    expect(te.params.ok).toBe(true);
    expect(te.params.output).toBe('built ok');
  });

  it('bash_execute 拒绝 -> tool.executed ok=false', async () => {
    const ctx = makeCtx();
    const model = scripted([
      { toolcall: { tool: 'bash_execute', input: { command: 'rm -r x' } } },
      { content: 'done' },
    ]);
    const run = runRealAgent(ctx, baseParams, { model });
    await waitEvent(ctx, EVENTS.ApprovalRequest);
    ctx.waiters[0].resolve(false);
    await run;
    const te = ctx.events.find((e) => e.method === EVENTS.ToolExecuted && e.params.tool === 'bash_execute')!;
    expect(te.params.ok).toBe(false);
    expect(te.params.output).toContain('拒绝');
  });

  it('命令命中策略拒绝 -> 不发审批', async () => {
    const ctx = makeCtx();
    const model = scripted([
      { toolcall: { tool: 'bash_execute', input: { command: 'rm -rf /' } } },
      { content: 'done' },
    ]);
    await runRealAgent(ctx, baseParams, {
      model,
      commandPolicy: { denyPatterns: [/rm\s+-rf/] },
    });
    expect(ctx.events.some((e) => e.method === EVENTS.ApprovalRequest)).toBe(false);
    const te = ctx.events.find((e) => e.method === EVENTS.ToolExecuted && e.params.tool === 'bash_execute')!;
    expect(te.params.ok).toBe(false);
    expect(te.params.output).toContain('拒绝');
  });

  it('bash_execute 被 allowedTools 禁用 -> 无审批，tool.executed ok=false', async () => {
    const ctx = makeCtx({ allowedTools: ['read_file'] });
    const model = scripted([
      { toolcall: { tool: 'bash_execute', input: { command: 'rm -rf x' } } },
      { content: 'done' },
    ]);
    await runRealAgent(ctx, baseParams, { model });
    expect(ctx.events.some((e) => e.method === EVENTS.ApprovalRequest)).toBe(false);
    const te = ctx.events.find((e) => e.method === EVENTS.ToolExecuted && e.params.tool === 'bash_execute')!;
    expect(te.params.ok).toBe(false);
  });
});

describe('realAgent：取消', () => {
  it('已取消 -> 立即结束 reason=canceled，模型正文不被流式输出', async () => {
    const ctx = makeCtx();
    ctx.setCanceled();
    const model = scripted([{ content: '不应输出' }]);
    await runRealAgent(ctx, baseParams, { model });
    const ended = ctx.events.find((e) => e.method === EVENTS.SessionEnded)!;
    expect(ended.params.reason).toBe('canceled');
    // 模型正文未被流式输出（仅取消提示）
    expect(ctx.events.some((e) => e.method === EVENTS.MessageDelta && e.params.delta.includes('不应输出'))).toBe(false);
  });
});

describe('realAgent：原生 function calling', () => {
  it('原生 tool_calls 优先消费，并回灌 tool_call_id 供下一轮模型', async () => {
    const ctx = makeCtx();
    const target = path.join(root, 'native.txt');
    fs.writeFileSync(target, 'NATIVE-READ\n', 'utf8');
    const seen: ChatMessage[][] = [];
    const model = new FakeChatModel((messages) => {
      seen.push(messages.map((m) => ({ ...m })));
      if (seen.length === 1) {
        return { reasoning: '原生调用', toolCalls: [{ tool: 'read_file', input: { path: target }, id: 'call_1' }] };
      }
      return { content: '读取完成' };
    });

    await runRealAgent(ctx, baseParams, { model });

    const te = ctx.events.find((e) => e.method === EVENTS.ToolExecuted && e.params.tool === 'read_file')!;
    expect(te.params.ok).toBe(true);
    expect(te.params.output).toContain('NATIVE-READ');
    // 第二轮模型收到的 assistant 消息带 toolCalls、tool 消息带 toolCallId
    const round2 = seen[1];
    expect(round2.some((m) => m.role === 'assistant' && m.toolCalls?.[0]?.id === 'call_1')).toBe(true);
    expect(round2.some((m) => m.role === 'tool' && m.toolCallId === 'call_1')).toBe(true);
  });

  it('无原生 tool_calls 时兜底解析 fenced 文本（向后兼容）', async () => {
    const ctx = makeCtx();
    const target = path.join(root, 'fenced.txt');
    fs.writeFileSync(target, 'FENCED-READ\n', 'utf8');
    const model = scripted([
      { toolcall: { tool: 'read_file', input: { path: target } } },
      { content: 'done' },
    ]);
    await runRealAgent(ctx, baseParams, { model });
    const te = ctx.events.find((e) => e.method === EVENTS.ToolExecuted && e.params.tool === 'read_file')!;
    expect(te.params.ok).toBe(true);
    expect(te.params.output).toContain('FENCED-READ');
  });
});