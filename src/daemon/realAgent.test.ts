import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EVENTS, ERROR_CODES } from '../../shared/protocol';
import { AgentCapabilities, AgentContext } from './agent';
import { ChatCompletionResult, ChatContentPart, ChatMessage, ChatModel, ChatStreamOptions, contentToText, FakeChatModel, FakeTurn, formatToolCallContent } from './model';
import { applyTokenBudget, estimateTokens, generateTitle, RealAgentConfig, runRealAgent, TITLE_SYSTEM_PROMPT } from './realAgent';
import { PLAN_MODE_MARKER } from './planMode';

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
  waiters: Array<{ kind: 'approval' | 'patch' | 'plan'; resolve: (v: boolean) => void }>;
  setCanceled(): void;
  /** P0-1：模拟 daemon 脏文档覆盖层（canonical 路径 -> 缓冲区内容；null = 脏但未上报内容） */
  overlay: Map<string, string | null>;
  /** P0-1：模拟"客户端已把改动应用到编辑器缓冲区"的 patchId 集合 */
  appliedInEditor: Set<string>;
}

function makeCtx(caps?: AgentCapabilities): MockCtx {
  const events: Array<{ method: string; params: any }> = [];
  const waiters: Array<{ kind: 'approval' | 'patch' | 'plan'; resolve: (v: boolean) => void }> = [];
  let canceled = false;
  // P0-3：模拟 server 的取消订阅语义（cancel 时同步触发，供 Agent abort 在途请求）
  const cancelHooks = new Set<() => void>();
  const fireCancel = () => {
    for (const fn of [...cancelHooks]) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
  };
  const ctx: MockCtx = {
    sessionId: 's1',
    workspaceRoot: root,
    capabilities: caps,
    notify: (method, params) => events.push({ method, params }),
    waitForUser: (kind) =>
      new Promise<boolean>((resolve) => waiters.push({ kind, resolve })),
    isCanceled: () => canceled,
    onCancel: (fn) => {
      if (canceled) {
        fn();
        return () => {};
      }
      cancelHooks.add(fn);
      return () => cancelHooks.delete(fn);
    },
    readFile: async (target) => {
      // P0-1：与 server 一致——覆盖层优先，未命中回落磁盘
      if (ctx.overlay.has(target)) return ctx.overlay.get(target) ?? undefined;
      return fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : undefined;
    },
    isDirty: (target) => ctx.overlay.has(target),
    isPatchAppliedInEditor: (patchId) => ctx.appliedInEditor.has(patchId),
    events,
    waiters,
    overlay: new Map<string, string | null>(),
    appliedInEditor: new Set<string>(),
    setCanceled: () => {
      canceled = true;
      fireCancel(); // 与 server 一致：置位后同步触发取消订阅
    },
  };
  return ctx;
}

function isTitleRequest(messages: ChatMessage[]): boolean {
  return messages.length === 2 && messages[0].role === 'system' && messages[0].content === TITLE_SYSTEM_PROMPT;
}

function scripted(turns: FakeTurn[], chunkSize = 4): ChatModel {
  const queue = [...turns];
  return new FakeChatModel((messages) => {
    if (isTitleRequest(messages)) return { content: '测试标题' };
    return queue.shift() ?? { content: '(无更多脚本回复)' };
  }, chunkSize);
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

describe('realAgent：P0-1 脏文档一致性', () => {
  it('read_file 脏文档优先：读到编辑器缓冲区内容而非过期磁盘内容，并明确标注', async () => {
    const ctx = makeCtx();
    ctx.overlay.set(file, 'BUFFER-ONLY（未保存改动）\n');
    const model = scripted([
      { toolcall: { tool: 'read_file', input: { path: file } } },
      { content: 'ok' },
    ]);
    await runRealAgent(ctx, baseParams, { model });

    const te = ctx.events.find((e) => e.method === EVENTS.ToolExecuted && e.params.tool === 'read_file')!;
    expect(te.params.ok).toBe(true);
    expect(te.params.output).toContain('BUFFER-ONLY');
    expect(te.params.output).not.toContain('TODO'); // 磁盘里的旧内容不该出现
    expect(te.params.output).toContain('未保存');
  });

  it('read_file 非脏文档：不出现"未保存"标注（不误导模型）', async () => {
    const ctx = makeCtx();
    const model = scripted([
      { toolcall: { tool: 'read_file', input: { path: file } } },
      { content: 'ok' },
    ]);
    await runRealAgent(ctx, baseParams, { model });
    const te = ctx.events.find((e) => e.method === EVENTS.ToolExecuted && e.params.tool === 'read_file')!;
    expect(te.params.output).toContain('TODO');
    expect(te.params.output).not.toContain('未保存');
  });

  it('read_file 行号精读建立在有效内容上：脏文档下按缓冲区切片，不读磁盘旧内容', async () => {
    const ctx = makeCtx();
    ctx.overlay.set(file, 'B1\nB2\nB3\nB4\n');
    const model = scripted([
      { toolcall: { tool: 'read_file', input: { path: file, startLine: 2, endLine: 3 } } },
      { content: 'ok' },
    ]);
    await runRealAgent(ctx, baseParams, { model });

    const te = ctx.events.find((e) => e.method === EVENTS.ToolExecuted && e.params.tool === 'read_file')!;
    expect(te.params.ok).toBe(true);
    expect(te.params.output).toContain('2| B2');
    expect(te.params.output).toContain('3| B3');
    expect(te.params.output).not.toContain('B1'); // 请求范围之外
    expect(te.params.output).not.toContain('TODO'); // 磁盘里的过期内容不该出现
    expect(te.params.output).toContain('未保存');
  });

  it('apply_patch 基准取自缓冲区：diff 的 old 侧与用户所见一致', async () => {
    const ctx = makeCtx();
    ctx.overlay.set(file, 'TODO-from-buffer\n');
    const model = scripted([
      {
        toolcall: {
          tool: 'apply_patch',
          input: { path: file, search: 'TODO-from-buffer', replace: 'DONE' },
        },
      },
      { content: 'ok' },
    ]);
    const run = runRealAgent(ctx, baseParams, { model });
    await waitEvent(ctx, EVENTS.FilePatchPending);
    const pending = ctx.events.find((e) => e.method === EVENTS.FilePatchPending)!;
    expect(pending.params.oldContent).toBe('TODO-from-buffer\n');
    expect(pending.params.newContent).toBe('DONE\n');
    ctx.waiters[0].resolve(false);
    await run;
  });

  it('accept 且客户端已应用到编辑器 -> daemon 不落盘，结果标记 appliedInEditor', async () => {
    const ctx = makeCtx();
    const before = fs.readFileSync(file, 'utf8');
    ctx.overlay.set(file, before);
    const model = scripted([
      { toolcall: { tool: 'write_file', input: { path: file, content: 'FROM-EDITOR\n' } } },
      { content: 'ok' },
    ]);
    const run = runRealAgent(ctx, baseParams, { model });

    await waitEvent(ctx, EVENTS.FilePatchPending);
    const patchId = ctx.events.find((e) => e.method === EVENTS.FilePatchPending)!.params.patchId;
    ctx.appliedInEditor.add(patchId); // 模拟 diffProvider 已把改动写进缓冲区
    ctx.waiters[0].resolve(true);
    await run;

    expect(fs.readFileSync(file, 'utf8')).toBe(before); // 磁盘未被改动
    const pr = ctx.events.find((e) => e.method === EVENTS.FilePatchResult)!;
    expect(pr.params.accepted).toBe(true);
    expect(pr.params.applied).toBe(false);
    expect(pr.params.appliedInEditor).toBe(true);
    expect(pr.params.error).toBeUndefined();
  });

  it('accept 但目标脏且未走编辑器 -> 拒绝落盘（安全默认），磁盘保持原样', async () => {
    const ctx = makeCtx();
    const before = fs.readFileSync(file, 'utf8');
    ctx.overlay.set(file, before);
    const model = scripted([
      { toolcall: { tool: 'write_file', input: { path: file, content: 'CLOBBER\n' } } },
      { content: 'ok' },
    ]);
    const run = runRealAgent(ctx, baseParams, { model });

    await waitEvent(ctx, EVENTS.FilePatchPending);
    ctx.waiters[0].resolve(true);
    await run;

    expect(fs.readFileSync(file, 'utf8')).toBe(before); // 未保存改动没有被覆盖
    const pr = ctx.events.find((e) => e.method === EVENTS.FilePatchResult)!;
    expect(pr.params.applied).toBe(false);
    expect(pr.params.appliedInEditor).toBeFalsy();
    expect(pr.params.error).toContain('未保存');
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

  it('P0-2 乐观锁：审阅期间文件被外部修改 -> 拒绝应用且不覆盖并发修改', async () => {
    const ctx = makeCtx();
    const p = path.join(root, 'conflict.txt');
    fs.writeFileSync(p, 'ORIGINAL\n', 'utf8');
    const model = scripted([
      { toolcall: { tool: 'write_file', input: { path: p, content: 'AGENT-CONTENT\n' } } },
      { content: 'done' },
    ]);
    const run = runRealAgent(ctx, { prompt: 'x', attachments: [{ kind: 'file', path: p }] }, { model });

    await waitEvent(ctx, EVENTS.FilePatchPending);
    // 模拟用户在审阅 Diff 期间从外部改动该文件（编辑器保存 / 另一会话的补丁）
    fs.writeFileSync(p, 'USER-EDIT-DURING-REVIEW\n', 'utf8');
    ctx.waiters[0].resolve(true);
    await run;

    // 关键断言：并发修改未被静默覆盖
    expect(fs.readFileSync(p, 'utf8')).toBe('USER-EDIT-DURING-REVIEW\n');
    const pr = ctx.events.find((e) => e.method === EVENTS.FilePatchResult)!;
    expect(pr.params.accepted).toBe(true);
    expect(pr.params.applied).toBe(false);
    expect(pr.params.error).toContain('乐观锁冲突');
    // 冲突须显式告知用户，不得静默
    expect(
      ctx.events.some(
        (e) => e.method === EVENTS.MessageDelta && String(e.params.delta).includes('乐观锁冲突')
      )
    ).toBe(true);
  });

  it('P0-2 乐观锁：审阅期间文件未被改动 -> 正常应用（无误伤）', async () => {
    const ctx = makeCtx();
    const p = path.join(root, 'noconflict.txt');
    fs.writeFileSync(p, 'ORIGINAL\n', 'utf8');
    const model = scripted([
      { toolcall: { tool: 'write_file', input: { path: p, content: 'AGENT-CONTENT\n' } } },
      { content: 'done' },
    ]);
    const run = runRealAgent(ctx, { prompt: 'x', attachments: [{ kind: 'file', path: p }] }, { model });
    await waitEvent(ctx, EVENTS.FilePatchPending);
    ctx.waiters[0].resolve(true);
    await run;

    expect(fs.readFileSync(p, 'utf8')).toBe('AGENT-CONTENT\n');
    const pr = ctx.events.find((e) => e.method === EVENTS.FilePatchResult)!;
    expect(pr.params.applied).toBe(true);
    expect(pr.params.error).toBeUndefined();
  });

  it('P0-2 乐观锁：文件在审阅期间被外部创建 -> 快照 undefined 与磁盘不一致亦判冲突', async () => {
    const ctx = makeCtx();
    const p = path.join(root, 'created-late.txt');
    const model = scripted([
      { toolcall: { tool: 'write_file', input: { path: p, content: 'AGENT-CONTENT\n' } } },
      { content: 'done' },
    ]);
    const run = runRealAgent(ctx, { prompt: 'x', attachments: [{ kind: 'file', path: p }] }, { model });

    await waitEvent(ctx, EVENTS.FilePatchPending);
    const pending = ctx.events.find((e) => e.method === EVENTS.FilePatchPending)!;
    expect(pending.params.oldContent).toBeUndefined(); // 审阅时文件尚不存在
    fs.writeFileSync(p, 'RACED-IN\n', 'utf8'); // 外部抢先创建
    ctx.waiters[0].resolve(true);
    await run;

    expect(fs.readFileSync(p, 'utf8')).toBe('RACED-IN\n');
    expect(ctx.events.find((e) => e.method === EVENTS.FilePatchResult)!.params.applied).toBe(false);
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

  it('P0-3 取消可中断在途请求：模型永不吐增量时取消能及时收尾（不等 onChunk）', async () => {
    const ctx = makeCtx();
    // 模拟"挂住的模型"：标题请求正常返回（否则会话起不来），正文请求不产生任何增量，
    // 只在 signal abort 时才 reject —— 旧实现下 onChunk 永不触发，abort 永不被调用，
    // 会话会永久卡在 running。
    let aborted = false;
    const hangingModel: ChatModel = {
      chat: (messages: ChatMessage[], opts: ChatStreamOptions = {}) => {
        if (isTitleRequest(messages)) return Promise.resolve<ChatCompletionResult>({ reasoning: '', content: '测试标题' });
        return new Promise<never>((_resolve, reject) => {
          const sig = opts.signal;
          if (!sig) return; // 永不 resolve（无 signal 时就是永久挂起）
          const fail = () => {
            aborted = true;
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
          };
          if (sig.aborted) return fail();
          sig.addEventListener('abort', fail, { once: true });
        });
      },
    };
    const run = runRealAgent(ctx, baseParams, {
      model: hangingModel,
      idleTimeoutMs: 0, // 关闭空闲超时，确保本用例只考察"取消"这条中断路径
    });

    await waitEvent(ctx, EVENTS.SessionStarted);
    expect(aborted).toBe(false); // 请求确实在途
    const t0 = Date.now();
    ctx.setCanceled(); // 触发 cancel 订阅 -> abort 在途 fetch
    await run;
    const elapsed = Date.now() - t0;

    expect(aborted).toBe(true); // 在途请求被真正中断
    expect(elapsed).toBeLessThan(1000); // 及时收尾，而非挂死
    const ended = ctx.events.find((e) => e.method === EVENTS.SessionEnded)!;
    expect(ended.params.reason).toBe('canceled');
  });

  it('P0-3 会话收尾后取消订阅被清理（不泄漏到下一轮）', async () => {
    const ctx = makeCtx();
    const model = scripted([{ content: 'done' }]);
    await runRealAgent(ctx, baseParams, { model });
    // runRealAgent 已 subscribe/unsubscribe；此处再 cancel 不应抛错、不应产生重复事件
    const before = ctx.events.length;
    ctx.setCanceled();
    expect(ctx.events.length).toBe(before);
  });
});

describe('realAgent：原生 function calling', () => {
  it('原生 tool_calls 优先消费，并回灌 tool_call_id 供下一轮模型', async () => {
    const ctx = makeCtx();
    const target = path.join(root, 'native.txt');
    fs.writeFileSync(target, 'NATIVE-READ\n', 'utf8');
    const seen: ChatMessage[][] = [];
    const model = new FakeChatModel((messages) => {
      if (isTitleRequest(messages)) return { content: '测试标题' };
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

describe('上下文 token 预算', () => {
  it('estimateTokens：CJK 约 1 token、ASCII 约 4 字符、空串 0', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('四个汉字')).toBe(4);
    expect(estimateTokens('abcdefgh')).toBe(2);
    expect(estimateTokens('ab中文')).toBe(3);
  });

  it('estimateTokens：平/片假名与注音按 1 token/字（不被低估）', () => {
    expect(estimateTokens('こんにちは')).toBe(5);
    expect(estimateTokens('カタカナ')).toBe(4);
    expect(estimateTokens('ㄅㄆㄇ')).toBe(3);
  });

  it('applyTokenBudget：不超预算原样返回（同一引用）', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'U' },
      { role: 'assistant', content: 'A' },
      { role: 'tool', content: 'T', toolCallId: 'c1' },
    ];
    expect(applyTokenBudget(msgs, 1000)).toBe(msgs);
  });

  it('applyTokenBudget：超预算整轮丢弃最旧轮次，保留 system+初始 user+最近轮', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'U' },
      { role: 'assistant', content: 'A'.repeat(100), toolCalls: [{ id: 'c1', tool: 'read_file', input: { path: '/x' } }] },
      { role: 'tool', content: 'T'.repeat(100), toolCallId: 'c1' },
      { role: 'assistant', content: 'B'.repeat(50) },
      { role: 'tool', content: 'U'.repeat(50), toolCallId: 'c2' },
    ];
    const r = applyTokenBudget(msgs, 60);
    expect(r.length).toBe(4);
    expect(r[0].role).toBe('system');
    expect(r[1].role).toBe('user');
    expect(r[2].role).toBe('assistant');
    expect(r[2].content).toBe('B'.repeat(50));
    expect(r[3].role).toBe('tool');
    expect(r[3].toolCallId).toBe('c2');
  });

  it('applyTokenBudget：计入原生 toolCalls JSON；极紧预算至少保留 system+user', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'U' },
      { role: 'assistant', content: 'x', toolCalls: [{ id: 'c1', tool: 'read_file', input: { path: '/x' } }] },
      { role: 'tool', content: 'y', toolCallId: 'c1' },
    ];
    // 不计 toolCalls 时恰为 4 token 不超；计入 JSON 后超预算 → 裁剪到 system+user
    expect(applyTokenBudget(msgs, 4).length).toBe(2);
    expect(applyTokenBudget(msgs, 0).length).toBe(2);
  });

  it('applyTokenBudget：结构异常（第三位非 assistant）原样返回不裁剪', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'U' },
      { role: 'user', content: 'extra' },
      { role: 'tool', content: 'T', toolCallId: 'c1' },
    ];
    expect(applyTokenBudget(msgs, 2)).toBe(msgs);
  });
});

describe('realAgent：上下文预算裁剪', () => {
  it('多轮读大文件超预算时，后续 chat 只收到 system+user 且记录裁剪轨迹', async () => {
    const ctx = makeCtx();
    const big = path.join(root, 'big.txt');
    fs.writeFileSync(big, 'x'.repeat(2000), 'utf8');
    const seen: ChatMessage[][] = [];
    let turn = 0;
    const model = new FakeChatModel((messages) => {
      if (isTitleRequest(messages)) return { content: '测试标题' };
      seen.push(messages.map((m) => ({ ...m })));
      turn++;
      if (turn <= 2) {
        return { toolCalls: [{ tool: 'read_file', input: { path: big }, id: `call_${turn}` }] };
      }
      return { content: 'done' };
    });
    await runRealAgent(ctx, baseParams, { model, maxContextTokens: 100, maxToolRounds: 4 });

    expect(seen).toHaveLength(3);
    // 每轮 chat 都被裁剪到 system+user（丢掉了前一轮的 assistant + tool 结果）
    expect(seen[0].length).toBe(2);
    expect(seen[1].length).toBe(2);
    expect(seen[2].length).toBe(2);
    expect(seen[2][0].role).toBe('system');
    expect(seen[2][1].role).toBe('user');
    // 裁剪轨迹被记录
    expect(ctx.events.some((e) => e.method === EVENTS.Trajectory && e.params.detail.includes('上下文裁剪'))).toBe(true);
  });
});

describe('标题生成', () => {
  it('generateTitle：模型返回标题，去空白保留语义', async () => {
    const model = new FakeChatModel(() => ({ content: '  解释递归 概念  ' }));
    const t = await generateTitle(model, '请解释什么是递归');
    expect(t).toBe('解释递归 概念');
  });

  it('generateTitle：模型返回超长则截断 40 字', async () => {
    const model = new FakeChatModel(() => ({ content: 'x'.repeat(100) }));
    const t = await generateTitle(model, '问');
    expect(t).toBe('x'.repeat(40));
  });

  it('generateTitle：空内容兜底 prompt 前 40 字', async () => {
    const model = new FakeChatModel(() => ({ content: '' }));
    const t = await generateTitle(model, 'x'.repeat(100));
    expect(t).toBe('x'.repeat(40));
  });

  it('generateTitle：模型抛错兜底 prompt 前 40 字', async () => {
    const model: ChatModel = {
      chat: async () => {
        throw new Error('boom');
      },
    };
    const t = await generateTitle(model, 'hello world');
    expect(t).toBe('hello world');
  });

  it('generateTitle：超时未返回则 abort 兜底', async () => {
    vi.useFakeTimers();
    try {
      const model: ChatModel = {
        chat: (_messages, opts) =>
          new Promise((_resolve, reject) => {
            opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      };
      const p = generateTitle(model, 'question');
      await vi.advanceTimersByTimeAsync(5000);
      await expect(p).resolves.toBe('question');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('realAgent：标题生成', () => {
  it('会话开始时生成标题并写入 SessionStarted', async () => {
    const ctx = makeCtx();
    const model = new FakeChatModel((messages) => {
      if (isTitleRequest(messages)) return { content: '解释递归' };
      return { content: '最终回答' };
    });
    await runRealAgent(ctx, baseParams, { model });

    const started = ctx.events.find((e) => e.method === EVENTS.SessionStarted)!;
    expect(started.params.title).toBe('解释递归');
  });
});

describe('realAgent：工具轮次耗尽必须收束（不得静默结束）', () => {
  /**
   * 记录每次 chat 是否携带了工具定义。
   * 「收束请求禁用了工具」这一条只能靠它验证——FakeChatModel 不暴露 opts。
   */
  function recordingModel(handler: (hasTools: boolean) => ChatCompletionResult): {
    model: ChatModel;
    calls: boolean[];
  } {
    const calls: boolean[] = [];
    const model: ChatModel = {
      async chat(messages, opts = {}) {
        if (isTitleRequest(messages)) return { reasoning: '', content: '测试标题' };
        const hasTools = !!(opts.tools && opts.tools.length > 0);
        calls.push(hasTools);
        const turn = handler(hasTools);
        if (turn.content) opts.onChunk?.({ type: 'content', text: turn.content });
        return turn;
      },
    };
    return { model, calls };
  }

  /** 永远"再调一次工具"的模型：逼出轮次耗尽。 */
  const keepCalling = (): ChatCompletionResult => ({
    reasoning: '',
    content: '我先看看目录结构。',
    toolCalls: [{ id: 'c1', tool: 'list_dir', input: { path: '.' } }],
  });

  function deltasOf(ctx: MockCtx): string {
    return ctx.events
      .filter((e) => e.method === EVENTS.MessageDelta)
      .map((e) => e.params.delta)
      .join('');
  }

  it('轮次耗尽 -> 补一次"不带 tools"的收束请求，最终结论送达且 reason=completed', async () => {
    const ctx = makeCtx();
    const { model, calls } = recordingModel((hasTools) =>
      hasTools ? keepCalling() : { reasoning: '', content: '最终结论：工作区结构正常，无阻塞项。' }
    );

    await runRealAgent(ctx, baseParams, { model, maxToolRounds: 3 });

    // 3 轮工具（每轮带 tools）+ 1 次收束（不带 tools）
    expect(calls).toEqual([true, true, true, false]);
    expect(deltasOf(ctx)).toContain('最终结论：工作区结构正常');
    expect(ctx.events.find((e) => e.method === EVENTS.SessionEnded)!.params.reason).toBe('completed');
  });

  it('收束请求仍没有正文 -> 显式告知用户（不再无声收场）', async () => {
    const ctx = makeCtx();
    const { model } = recordingModel((hasTools) => (hasTools ? keepCalling() : { reasoning: '', content: '   ' }));

    await runRealAgent(ctx, baseParams, { model, maxToolRounds: 2 });

    expect(deltasOf(ctx)).toContain('工具调用已达上限（2 轮）');
  });

  it('收束请求失败 -> 报 error 且以 reason=error 收尾（不谎报"已完成"）', async () => {
    const ctx = makeCtx();
    const calls: boolean[] = [];
    const model: ChatModel = {
      async chat(messages, opts = {}) {
        if (isTitleRequest(messages)) return { reasoning: '', content: '测试标题' };
        const hasTools = !!(opts.tools && opts.tools.length > 0);
        calls.push(hasTools);
        if (hasTools) return keepCalling();
        throw new Error('连接被重置');
      },
    };

    await runRealAgent(ctx, baseParams, { model, maxToolRounds: 1 });

    expect(ctx.events.find((e) => e.method === EVENTS.Error)!.params.message).toContain('收束回答失败');
    expect(ctx.events.find((e) => e.method === EVENTS.SessionEnded)!.params.reason).toBe('error');
    expect(deltasOf(ctx)).toContain('工具调用已达上限（1 轮）');
  });

  it('模型主动收尾（无工具调用）-> 不追加收束请求', async () => {
    const ctx = makeCtx();
    const { model, calls } = recordingModel(() => ({ reasoning: '', content: '直接给出结论。' }));

    await runRealAgent(ctx, baseParams, { model, maxToolRounds: 3 });

    expect(calls).toHaveLength(1); // 只有正常那一轮，没有多余的收束请求
    expect(ctx.events.filter((e) => e.method === EVENTS.MessageDone)).toHaveLength(1);
  });

  it('工作区相对路径（list_dir "."）直接可用：不再逼模型改用需审批的 bash_execute', async () => {
    // 这是"轮次被白白吃光"的源头：`.` 被判越界后，模型只好改用 bash_execute（ls/dir）列目录，
    // 每次都要用户审批且各占一轮。相对路径按工作区根解析后，只读工具直接就能用。
    const ctx = makeCtx();
    const { model } = recordingModel((hasTools) =>
      hasTools
        ? { reasoning: '', content: '', toolCalls: [{ id: 'c1', tool: 'list_dir', input: { path: '.' } }] }
        : { reasoning: '', content: '结论。' }
    );

    await runRealAgent(ctx, baseParams, { model, maxToolRounds: 1 });

    const exec = ctx.events.find((e) => e.method === EVENTS.ToolExecuted)!;
    expect(exec.params.ok).toBe(true);
    expect(exec.params.output).toContain('a.txt');
    // 没有发起任何审批（只读工具本就不该审批）
    expect(ctx.events.some((e) => e.method === EVENTS.ApprovalRequest)).toBe(false);
  });

  it('轮次耗尽但已被取消 -> 不发起收束请求，按 canceled 收尾', async () => {
    const ctx = makeCtx();
    const calls: boolean[] = [];
    const model: ChatModel = {
      async chat(messages, opts = {}) {
        if (isTitleRequest(messages)) return { reasoning: '', content: '测试标题' };
        calls.push(!!(opts.tools && opts.tools.length > 0));
        ctx.setCanceled(); // 模拟"用户不等了"
        return keepCalling();
      },
    };

    await runRealAgent(ctx, baseParams, { model, maxToolRounds: 3 });

    expect(calls.filter((hasTools) => !hasTools)).toHaveLength(0);
    expect(ctx.events.find((e) => e.method === EVENTS.SessionEnded)!.params.reason).toBe('canceled');
  });
});

/**
 * 展示层剥离（回归）。
 *
 * 真实缺陷：模型把工具调用写在正文里，`streamChunk` 原样把它当 `message.delta` 推给面板，
 * 于是每轮调用的原始 JSON 永久留在答案气泡里（还进 `.dsh/history.json`）。
 * 这里在**事件层**钉住症状：正文照常流式，围栏与原始 JSON 不得出现在 `message.delta` 里。
 */
describe('realAgent：工具调用围栏不落进答案区', () => {
  function deltas(ctx: MockCtx): string {
    return ctx.events
      .filter((e) => e.method === EVENTS.MessageDelta)
      .map((e) => e.params.delta)
      .join('');
  }

  /** 逐 4 字符推送（围栏必然被切开，覆盖增量剥离） */
  function streamingModel(contents: string[]): ChatModel {
    let i = 0;
    return {
      async chat(messages, opts = {}) {
        if (isTitleRequest(messages)) return { reasoning: '', content: '测试标题' };
        const content = contents[Math.min(i++, contents.length - 1)];
        for (let at = 0; at < content.length; at += 4) {
          opts.onChunk?.({ type: 'content', text: content.slice(at, at + 4) });
        }
        return { reasoning: '', content };
      },
    };
  }

  it('正文照常流式，```toolcall 块与其原始 JSON 不出现', async () => {
    const ctx = makeCtx();
    const model = streamingModel([
      `我先读取该文件。\n\n${formatToolCallContent({ tool: 'read_file', input: { path: file } })}`,
      '最终结论：文件内容已确认。',
    ]);

    await runRealAgent(ctx, baseParams, { model });

    const text = deltas(ctx);
    expect(text).toContain('我先读取该文件。');
    expect(text).toContain('最终结论：文件内容已确认。');
    expect(text).not.toContain('```');
    expect(text).not.toContain('"tool"');
    // 工具确实跑了（只吞展示，不影响分派）
    expect(ctx.events.some((e) => e.method === EVENTS.ToolExecuted && e.params.tool === 'read_file')).toBe(true);
  });

  it('收束请求不剥离：那里没有工具，正文里的围栏是内容', async () => {
    const ctx = makeCtx();
    // keepCalling：每轮都带原生工具调用 -> 轮次耗尽后转入收束；收束那轮给出含围栏的正文
    const finalText = '示例如下：\n```toolcall\n{"tool":"read_file","input":{"path":"/a"}}\n```';
    let calls = 0;
    const model: ChatModel = {
      async chat(messages, opts = {}) {
        if (isTitleRequest(messages)) return { reasoning: '', content: '测试标题' };
        const hasTools = !!(opts.tools && opts.tools.length > 0);
        calls++;
        if (hasTools) {
          return {
            reasoning: '',
            content: '我先看看目录结构。',
            toolCalls: [{ id: 'c1', tool: 'list_dir', input: { path: '.' } }],
          };
        }
        opts.onChunk?.({ type: 'content', text: finalText });
        return { reasoning: '', content: finalText };
      },
    };

    await runRealAgent(ctx, baseParams, { model, maxToolRounds: 1 });

    expect(calls).toBe(2); // 1 轮工具 + 1 次收束
    expect(deltas(ctx)).toContain('```toolcall');
  });

  it('采样参数透传给模型：配了才下发，没配即 undefined（不改动既有行为）', async () => {
    const seen: Array<{ temperature?: number; maxTokens?: number }> = [];
    const model: ChatModel = {
      async chat(messages, opts = {}) {
        if (isTitleRequest(messages)) return { reasoning: '', content: '测试标题' };
        seen.push({ temperature: opts.temperature, maxTokens: opts.maxTokens });
        return { reasoning: '', content: '好的。' };
      },
    };

    await runRealAgent(makeCtx(), { prompt: '你好' }, { model, temperature: 0.9, maxTokens: 2048 });
    expect(seen).toEqual([{ temperature: 0.9, maxTokens: 2048 }]);

    // 未配置时必须是 undefined（而不是被 Agent 层补成 0.2 / 4096）——
    // 补缺省是模型层的职责，Agent 层一旦补，就会把"没配"和"配成缺省值"混为一谈。
    seen.length = 0;
    await runRealAgent(makeCtx(), { prompt: '你好' }, { model });
    expect(seen).toEqual([{ temperature: undefined, maxTokens: undefined }]);
  });
});

// ---------------------------------------------------------------------------
// Plan 模式（P2-7）
// ---------------------------------------------------------------------------

/** 记录每次模型调用看到的 tools 与 messages，用于断言"计划阶段没有写入类工具"。 */
function recording(inner: ChatModel): {
  model: ChatModel;
  toolSets: Array<string[] | undefined>;
  // content 可能是内容块数组（图片，批次 6）：断言只看结构，所以按联合类型收
  calls: Array<{ tools?: string[]; messages: Array<{ role: string; content: ChatContentPart[] | string }> }>;
} {
  const toolSets: Array<string[] | undefined> = [];
  const calls: Array<{ tools?: string[]; messages: Array<{ role: string; content: ChatContentPart[] | string }> }> = [];
  return {
    toolSets,
    calls,
    model: {
      chat: (messages, opts) => {
        const tools = opts?.tools?.map((t) => t.name);
        toolSets.push(tools);
        calls.push({ tools, messages: messages.map((m) => ({ role: m.role, content: m.content })) });
        return inner.chat(messages, opts);
      },
    },
  };
}

/** 只保留真正带工具清单的调用（标题生成那次没有 tools）。 */
function toolCallsOf(rec: ReturnType<typeof recording>): Array<string[] | undefined> {
  return rec.calls.filter((c) => c.tools !== undefined).map((c) => c.tools);
}

describe('realAgent：Plan 模式（P2-7）', () => {
  const original = 'TODO\nline2\n';

  it('调研阶段只提供只读工具：写入类工具压根不在清单里', async () => {
    const ctx = makeCtx();
    const rec = recording(scripted([{ content: '## 计划\n1. 改 a.txt' }]));
    const run = runRealAgent(ctx, { ...baseParams, planMode: true }, { model: rec.model });

    const planEvt = await waitEvent(ctx, EVENTS.PlanRequest);
    expect(String(planEvt.params.plan)).toContain('计划');
    // 承诺必须落在工具清单这一层：提示词说"别改文件"是不可靠的
    expect(toolCallsOf(rec)[0]!.slice().sort()).toEqual(['glob', 'grep', 'list_dir', 'read_file']);
    // 还没批准 -> 不可能已经有补丁请求
    expect(ctx.events.some((e) => e.method === EVENTS.FilePatchPending)).toBe(false);

    ctx.waiters.find((w) => w.kind === 'plan')!.resolve(false);
    await run;
  });

  it('批准后进入执行阶段：工具集恢复完整，计划与系统提示词各自归位', async () => {
    const ctx = makeCtx();
    const rec = recording(
      scripted([
        { content: '## 计划\n1. 改 a.txt' }, // 调研阶段
        { toolcall: { tool: 'write_file', input: { path: file, content: 'NEW' } } }, // 执行阶段
        { content: '已完成' },
      ])
    );
    const run = runRealAgent(ctx, { ...baseParams, planMode: true }, { model: rec.model });

    await waitEvent(ctx, EVENTS.PlanRequest);
    ctx.waiters.find((w) => w.kind === 'plan')!.resolve(true);
    await waitEvent(ctx, EVENTS.FilePatchPending);
    ctx.waiters.find((w) => w.kind === 'patch')!.resolve(true);
    await run;

    const toolSets = toolCallsOf(rec);
    expect(toolSets[0]!.slice().sort()).toEqual(['glob', 'grep', 'list_dir', 'read_file']);
    expect(toolSets[1]).toContain('write_file');
    expect(fs.readFileSync(file, 'utf8')).toBe('NEW');

    // 执行阶段的首条 system 必须是完整提示词（计划标记只在调研阶段出现），
    // 否则"计划模式"的约束会一路带到执行阶段，模型会继续不敢动手。
    const execCall = rec.calls.find((c) => c.tools?.includes('write_file'))!;
    expect(execCall.messages[0].role).toBe('system');
    expect(execCall.messages[0].content).not.toContain(PLAN_MODE_MARKER);
    expect(execCall.messages[0].content).toContain('你是 dsh');
    // 调研阶段的上下文要留下（不然执行阶段会把同一批文件再读一遍）
    expect(execCall.messages.some((m) => contentToText(m.content).startsWith('【已批准的计划】'))).toBe(true);
  });

  it('拒绝计划：一个文件都不碰，按「已取消」收尾而不是谎报已完成', async () => {
    // 用例间共用同一个临时文件，先复位（否则读到的是上一条用例写进去的内容）
    fs.writeFileSync(file, original, 'utf8');
    const ctx = makeCtx();
    const rec = recording(scripted([{ content: '## 计划\n1. 改 a.txt' }]));
    const run = runRealAgent(ctx, { ...baseParams, planMode: true }, { model: rec.model });

    await waitEvent(ctx, EVENTS.PlanRequest);
    ctx.waiters.find((w) => w.kind === 'plan')!.resolve(false);
    await run;

    expect(ctx.events.some((e) => e.method === EVENTS.FilePatchPending)).toBe(false);
    const deltas = ctx.events
      .filter((e) => e.method === EVENTS.MessageDelta)
      .map((e) => String(e.params.delta))
      .join('');
    expect(deltas).toContain('没有改动任何文件');
    expect(ctx.events.find((e) => e.method === EVENTS.SessionEnded)!.params.reason).toBe('canceled');
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });

  it('批准时带的补充意见回灌进执行指令（"批准但要求改一处"是常见表态）', async () => {
    const ctx = makeCtx();
    ctx.getPlanNote = () => '第 2 步不要动 b.ts';
    const rec = recording(
      scripted([{ content: '## 计划' }, { toolcall: { tool: 'write_file', input: { path: file, content: 'X' } } }, { content: 'ok' }])
    );
    const run = runRealAgent(ctx, { ...baseParams, planMode: true }, { model: rec.model });

    await waitEvent(ctx, EVENTS.PlanRequest);
    ctx.waiters.find((w) => w.kind === 'plan')!.resolve(true);
    await waitEvent(ctx, EVENTS.FilePatchPending);
    ctx.waiters.find((w) => w.kind === 'patch')!.resolve(false);
    await run;

    const execCall = rec.calls.find((c) => c.tools?.includes('write_file'))!;
    const text = execCall.messages.map((m) => m.content).join('\n');
    expect(text).toContain('第 2 步不要动 b.ts');
  });

  it('调研预算用尽仍未产出计划时收束一次；收束仍为空则明确告知（不静默收场）', async () => {
    const ctx = makeCtx();
    // 4 轮都发起只读调用 -> 调研预算用尽 -> 收束请求（不传 tools）返回空内容
    const turns: FakeTurn[] = Array.from({ length: 4 }, () => ({
      toolcall: { tool: 'list_dir', input: { path: '.' } },
    }));
    turns.push({ content: '' });
    const rec = recording(scripted(turns));
    await runRealAgent(ctx, { ...baseParams, planMode: true }, { model: rec.model });

    // 收束请求必须**不带工具**（与主循环轮次耗尽时同一条纪律）
    expect(rec.calls[rec.calls.length - 1].tools).toBeUndefined();
    // 「没产出计划」要说出来，否则用户只看到一屏工具行然后会话就结束了
    const deltas = ctx.events
      .filter((e) => e.method === EVENTS.MessageDelta)
      .map((e) => String(e.params.delta))
      .join('');
    expect(deltas).toContain('未能产出计划');
    expect(ctx.events.find((e) => e.method === EVENTS.SessionEnded)!.params.reason).toBe('error');
  });

  it('不开 planMode 时行为与原路径一致：不出现 plan.request，工具集从头就是完整的', async () => {
    const ctx = makeCtx();
    const rec = recording(scripted([{ content: '直接作答' }]));
    await runRealAgent(ctx, baseParams, { model: rec.model });

    expect(ctx.events.some((e) => e.method === EVENTS.PlanRequest)).toBe(false);
    expect(toolCallsOf(rec)[0]).toContain('write_file');
  });
});
/**
 * 图片输入（P2-4）。
 *
 * 这里守的是 daemon 侧的**最后一道**校验与消息装配 —— 面板里已经校验过一次，
 * 但 daemon 是安全边界（协议允许任意客户端接入，`examples/python-daemon` 就是活证据），
 * 凡是**要发给模型**的内容必须在真正使用它的那一刻再验一次。
 *
 * 另外两条不变量：① 图片走独立内容块、文本侧只留 `[图片 N]` 位置标记；
 * ② 没有图片时 user 消息必须仍是**裸字符串**（改造前后请求体逐字节一致）。
 */
describe('realAgent：图片输入（P2-4）', () => {
  const PNG = 'iVBORw0KGgo=';
  const img = (over: Record<string, unknown> = {}) => ({
    kind: 'image' as const,
    mimeType: 'image/png' as const,
    dataBase64: PNG,
    name: 'shot.png',
    clientId: 'c1',
    ...over,
  });

  /** 记录模型真正收到的消息（标题生成那一次用 TITLE_SYSTEM_PROMPT 单独识别并跳过）。 */
  function captureModel(): { model: ChatModel; calls: ChatMessage[][] } {
    const calls: ChatMessage[][] = [];
    const model: ChatModel = {
      async chat(messages, opts = {}) {
        if (isTitleRequest(messages)) return { reasoning: '', content: '测试标题' };
        calls.push(messages);
        opts.onChunk?.({ type: 'content', text: '收到' });
        return { reasoning: '', content: '收到' };
      },
    };
    return { model, calls };
  }

  const userParts = (messages: ChatMessage[]): ChatContentPart[] => messages[1].content as ChatContentPart[];
  const textOf = (messages: ChatMessage[]): string => {
    const c = messages[1].content;
    return typeof c === 'string' ? c : c.filter((p) => p.type === 'text').map((p) => (p.type === 'text' ? p.text : '')).join('\n');
  };

  it('图片作为独立内容块到达模型，文本只留 [图片 N] 位置标记（base64 不折进文本）', async () => {
    const ctx = makeCtx();
    const { model, calls } = captureModel();
    await runRealAgent(
      ctx,
      { prompt: '看这个报错', attachments: [{ kind: 'file', path: file, name: 'a.txt' }, img()] },
      { model }
    );

    expect(calls).toHaveLength(1);
    expect(calls[0][0].role).toBe('system');
    const parts = userParts(calls[0]);
    expect(Array.isArray(parts)).toBe(true);
    // text 必须在前：位置标记与图片块的先后顺序是两家 provider 都能接受的形式
    expect(parts[0]).toMatchObject({ type: 'text' });
    expect(parts[1]).toEqual({ type: 'image', mimeType: 'image/png', dataBase64: PNG });
    // 文本侧看得到"有第几张图"和文件上下文，但看不见 base64
    expect(textOf(calls[0])).toContain('[图片 1：shot.png]');
    expect(textOf(calls[0])).toContain('<file');
    expect(textOf(calls[0])).not.toContain(PNG);
  });

  it('多张图：编号按附件顺序递增，数组里的顺序与之一致（"[图片 2]"必须真指第 2 张）', async () => {
    const ctx = makeCtx();
    const { model, calls } = captureModel();
    await runRealAgent(
      ctx,
      {
        prompt: '两张都看',
        attachments: [
          img({ name: 'a.png', clientId: 'a', dataBase64: 'AAAA' }),
          img({ name: 'b.png', clientId: 'b', dataBase64: 'AA==' }),
        ],
      },
      { model }
    );

    const text = textOf(calls[0]);
    expect(text).toContain('[图片 1：a.png]');
    expect(text).toContain('[图片 2：b.png]');
    expect(text.indexOf('[图片 1：a.png]')).toBeLessThan(text.indexOf('[图片 2：b.png]'));
    expect(userParts(calls[0]).slice(1)).toEqual([
      { type: 'image', mimeType: 'image/png', dataBase64: 'AAAA' },
      { type: 'image', mimeType: 'image/png', dataBase64: 'AA==' },
    ]);
  });

  it('没有名字时不出现空括号（`[图片 1：]` 会被模型当成残缺信息）', async () => {
    const ctx = makeCtx();
    const { model, calls } = captureModel();
    await runRealAgent(ctx, { prompt: '看图', attachments: [img({ name: undefined })] }, { model });
    expect(textOf(calls[0])).toContain('[图片 1]');
    expect(textOf(calls[0])).not.toContain('[图片 1：]');
  });

  it('只发图不写字也成立（粘一张截图直接回车是最常见的用法）', async () => {
    const ctx = makeCtx();
    const { model, calls } = captureModel();
    await runRealAgent(ctx, { prompt: '', attachments: [img()] }, { model });
    expect(calls).toHaveLength(1);
    expect(userParts(calls[0])).toHaveLength(2);
  });

  it('无图片时 user 消息仍是**裸字符串**，不是内容块数组（无图片的请求逐字节不变）', async () => {
    const ctx = makeCtx();
    const { model, calls } = captureModel();
    await runRealAgent(ctx, baseParams, { model });
    expect(typeof calls[0][1].content).toBe('string');
  });

  it('声明体积撒谎也不能放行：实测超限照样拒绝（体积以真字节数为准）', async () => {
    const ctx = makeCtx();
    const { model, calls } = captureModel();
    // 6MB 真内容 + sizeBytes 声明为 1
    const huge = 'A'.repeat(8_000_000);
    await runRealAgent(ctx, { prompt: '看图', attachments: [img({ dataBase64: huge, sizeBytes: 1 })] }, { model });

    expect(calls).toHaveLength(0);
    expect(ctx.events.find((e) => e.method === EVENTS.SessionEnded)!.params.reason).toBe('error');
  });

  it('不合规图片 -> 整条消息明确拒绝：不发 session.started、模型一次都没被调用', async () => {
    const ctx = makeCtx();
    const { model, calls } = captureModel();
    await runRealAgent(ctx, { prompt: '看图', attachments: [img({ mimeType: 'image/svg+xml' })] }, { model });

    // 关键：**不是**丢掉那张继续发。少发一张会让模型对着不存在的图作答，
    // 用户拿到的是一段看起来完全正常的胡话 —— 比直接报错难发现得多。
    expect(calls).toHaveLength(0);
    expect(ctx.events.some((e) => e.method === EVENTS.SessionStarted)).toBe(false);

    const err = ctx.events.find((e) => e.method === EVENTS.Error);
    expect(err).toBeTruthy();
    expect(err!.params.code).toBe(ERROR_CODES.InvalidParams);
    expect(err!.params.message).toContain('图片附件被拒绝');

    // 原因同时进正文（用户看得到），并且以 error 收尾而不是 completed
    const deltas = ctx.events.filter((e) => e.method === EVENTS.MessageDelta).map((e) => e.params.delta).join('');
    expect(deltas).toContain('不支持');
    expect(ctx.events.find((e) => e.method === EVENTS.SessionEnded)!.params.reason).toBe('error');
  });

  it('超出张数上限同样整条拒绝，且原因说得出该删哪一张', async () => {
    const ctx = makeCtx();
    const { model, calls } = captureModel();
    await runRealAgent(
      ctx,
      { prompt: '看图', attachments: Array.from({ length: 5 }, () => img()) },
      { model }
    );
    expect(calls).toHaveLength(0);
    const deltas = ctx.events.filter((e) => e.method === EVENTS.MessageDelta).map((e) => e.params.delta).join('');
    expect(deltas).toContain('最多');
  });

  it('非图片附件不受图片校验影响（校验只挑 kind=image 的那几条）', async () => {
    const ctx = makeCtx();
    const { model, calls } = captureModel();
    await runRealAgent(
      ctx,
      {
        prompt: '杂附件',
        attachments: [
          { kind: 'text', text: '一段纯文本' },
          img(),
          { kind: 'selection', path: file, name: 'a.txt', range: { startLine: 1, endLine: 2 }, content: 'x' },
        ],
      },
      { model }
    );

    expect(calls).toHaveLength(1);
    const text = textOf(calls[0]);
    expect(text).toContain('<text>一段纯文本</text>');
    expect(text).toContain('<selection');
    // 图片块的相对顺序也保持（附件里排在 text 之后）
    expect(userParts(calls[0]).filter((p) => p.type === 'image')).toHaveLength(1);
  });

  it('图片计入上下文预算：超预算时裁掉旧轮次也**不会**丢初始用户消息里的图', async () => {
    const ctx = makeCtx();
    const seen: ChatMessage[][] = [];
    let turn = 0;
    const big = path.join(root, 'big2.txt');
    fs.writeFileSync(big, 'x'.repeat(2000), 'utf8');
    const model: ChatModel = {
      async chat(messages, opts = {}) {
        if (isTitleRequest(messages)) return { reasoning: '', content: '测试标题' };
        seen.push(messages);
        turn++;
        // content 必须给：assistant 消息会带着它回灌，undefined 会让下一轮的 token 估算炸掉
        if (turn <= 2) {
          return { reasoning: '', content: '我先看看。', toolCalls: [{ tool: 'read_file', input: { path: big }, id: `c${turn}` }] };
        }
        opts.onChunk?.({ type: 'content', text: 'done' });
        return { reasoning: '', content: 'done' };
      },
    };

    await runRealAgent(ctx, { prompt: '看图', attachments: [img()] }, { model, maxContextTokens: 100, maxToolRounds: 4 });

    expect(seen.length).toBe(3);
    // 每轮都被裁到 system+user，而 user 里那把图还在（图片是"提问本身"，丢了它整轮就没意义）
    for (const messages of seen) {
      expect(messages).toHaveLength(2);
      expect(messages[1].content).toEqual([
        { type: 'text', text: expect.stringContaining('[图片 1') },
        { type: 'image', mimeType: 'image/png', dataBase64: PNG },
      ]);
    }
  });
});

/**
 * P2-8 结构化轨迹。
 *
 * 目的不是"多记几个字段"，而是让"哪类工具最容易失败""单会话成本"能直接聚合出来 ——
 * 因此这里逐条钉住 ok / durationMs / errorKind 三种失败分类，以及 token 估算记录。
 */
describe('realAgent：结构化轨迹（P2-8）', () => {
  const trajs = (ctx: MockCtx): any[] =>
    ctx.events.filter((e) => e.method === EVENTS.Trajectory).map((e) => e.params);

  it('工具成功 -> 记录带 tool / ok:true / durationMs', async () => {
    const ctx = makeCtx();
    const model = scripted([
      { toolcall: { tool: 'read_file', input: { path: file } } },
      { content: '完成' },
    ]);
    await runRealAgent(ctx, baseParams, { model });

    const done = trajs(ctx).find((t) => t.tool === 'read_file' && t.ok === true);
    expect(done).toBeTruthy();
    expect(typeof done.durationMs).toBe('number');
    expect(done.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('工具被 allowedTools 禁用 -> errorKind=tool-disabled（不并进"执行失败"）', async () => {
    const ctx = makeCtx({ allowedTools: ['list_dir'] });
    const model = scripted([
      { toolcall: { tool: 'read_file', input: { path: file } } },
      { content: '完成' },
    ]);
    await runRealAgent(ctx, baseParams, { model });

    const rec = trajs(ctx).find((t) => t.errorKind === 'tool-disabled');
    expect(rec).toBeTruthy();
    expect(rec.tool).toBe('read_file');
    expect(rec.ok).toBe(false);
  });

  it('命令被策略拒绝 -> errorKind=policy-denied', async () => {
    const ctx = makeCtx();
    const model = scripted([
      { toolcall: { tool: 'bash_execute', input: { command: 'rm -rf /' } } },
      { content: '完成' },
    ]);
    await runRealAgent(ctx, baseParams, { model, commandPolicy: { denyPatterns: [/rm\s+-rf/] } });

    const rec = trajs(ctx).find((t) => t.errorKind === 'policy-denied');
    expect(rec).toBeTruthy();
    expect(rec.tool).toBe('bash_execute');
    expect(rec.ok).toBe(false);
  });

  it('用户拒绝审批 -> errorKind=approval-denied（与"执行失败"分开计数）', async () => {
    const ctx = makeCtx();
    const model = scripted([
      { toolcall: { tool: 'bash_execute', input: { command: 'npm run build' } } },
      { content: '完成' },
    ]);
    const run = runRealAgent(ctx, baseParams, {
      model,
      commandRunner: async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }),
    });
    await waitEvent(ctx, EVENTS.ApprovalRequest);
    ctx.waiters[0].resolve(false);
    await run;

    const rec = trajs(ctx).find((t) => t.errorKind === 'approval-denied');
    expect(rec).toBeTruthy();
    expect(rec.ok).toBe(false);
  });

  it('每轮模型调用 -> 一条 token 估算（estimated 恒为 true，不得当账单用）', async () => {
    const ctx = makeCtx();
    const model = scripted([
      { toolcall: { tool: 'read_file', input: { path: file } } },
      { content: '完成' },
    ]);
    await runRealAgent(ctx, baseParams, { model });

    const withTokens = trajs(ctx).filter((t) => t.tokens && typeof t.tokens.total === 'number');
    expect(withTokens.length).toBeGreaterThanOrEqual(2); // 工具轮 + 收尾轮
    for (const t of withTokens) {
      expect(t.tokens.estimated).toBe(true);
      expect(t.tokens.total).toBe((t.tokens.prompt ?? 0) + (t.tokens.completion ?? 0));
    }
  });

  it('未带结构化字段的记录保持原形态（reasoning 记录不得被塞入 tool/ok）', async () => {
    const ctx = makeCtx();
    const model = scripted([{ reasoning: '思考中', content: '完成' }]);
    await runRealAgent(ctx, baseParams, { model });

    const reasoning = trajs(ctx).find((t) => t.kind === 'reasoning');
    expect(reasoning.detail).toContain('思考中');
    expect(reasoning.tool).toBeUndefined();
    expect(reasoning.ok).toBeUndefined();
    expect(reasoning.durationMs).toBeUndefined();
  });

  it('审批记录带风险等级对应的 tool 字段（与 9b 的分级配套）', async () => {
    const ctx = makeCtx();
    const model = scripted([
      { toolcall: { tool: 'bash_execute', input: { command: 'npm run build' } } },
      { content: '完成' },
    ]);
    const run = runRealAgent(ctx, baseParams, {
      model,
      commandRunner: async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }),
    });
    await waitEvent(ctx, EVENTS.ApprovalRequest);
    const req = trajs(ctx).find((t) => t.kind === 'approval' && t.detail.includes('approval.request'));
    expect(req.tool).toBe('bash_execute');
    ctx.waiters[0].resolve(true);
    await run;
  });
});
