import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EVENTS, ERROR_CODES } from '../../shared/protocol';
import { AgentCapabilities, AgentContext } from './agent';
import { ChatCompletionResult, ChatMessage, ChatModel, ChatStreamOptions, FakeChatModel, FakeTurn, formatToolCallContent } from './model';
import { applyTokenBudget, estimateTokens, generateTitle, RealAgentConfig, runRealAgent, TITLE_SYSTEM_PROMPT } from './realAgent';

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
  /** P0-1：模拟 daemon 脏文档覆盖层（canonical 路径 -> 缓冲区内容；null = 脏但未上报内容） */
  overlay: Map<string, string | null>;
  /** P0-1：模拟"客户端已把改动应用到编辑器缓冲区"的 patchId 集合 */
  appliedInEditor: Set<string>;
}

function makeCtx(caps?: AgentCapabilities): MockCtx {
  const events: Array<{ method: string; params: any }> = [];
  const waiters: Array<{ kind: 'approval' | 'patch'; resolve: (v: boolean) => void }> = [];
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
});