/**
 * 真实 Agent 循环（P3.2）。
 *
 * 与 runFakeAgent 实现完全相同的 AgentContext 契约，因此 server 侧只需换一行调用。
 * 行为：模型流式推理/回答（reasoning.delta / message.delta）→ 解析工具调用 →
 * 分派真实工具（路径护栏 + 审批门控）→ 回灌工具结果 → 继续，直至不再调用工具或取消。
 */
import {
  EVENTS,
  ERROR_CODES,
  EventApprovalRequest,
  EventFilePatchPending,
  SessionSendParams,
} from '../../shared/protocol';
import * as path from 'path';
import { AgentCapabilities, AgentContext } from './agent';
import { ChatMessage, ChatModel } from './model';
import { parseToolCalls, ToolCall } from './toolcall';
import {
  CommandPolicy,
  CommandRunner,
  evaluateCommandPolicy,
  executeCommand,
  listDirectory,
  readTextFile,
  resolveTarget,
  tryReadFile,
  writeTextFile,
} from './tools';

export interface RealAgentConfig {
  model: ChatModel;
  /** 高危命令策略（缺省 = 全部允许但需审批） */
  commandPolicy?: CommandPolicy;
  /** 命令执行器（测试注入；缺省 child_process） */
  commandRunner?: CommandRunner;
  /** 工具调用轮数上限，防止死循环 */
  maxToolRounds?: number;
  /** 工具读取单文件上限（字节） */
  maxReadBytes?: number;
}

let stepCounter = 0;

const SYSTEM_PROMPT = [
  '你是 dsh，运行在 VSCode 扩展中的编程智能体。你通过工具与工作区交互，并遵守以下规则：',
  '',
  '1. 需要读取文件时调用工具 read_file；需要列出目录调用 list_dir。',
  '2. 需要修改/创建文件时，不要直接写盘，而是调用工具 write_file {path, content}（全量覆盖）',
  '   或 apply_patch {path, search, replace}（字符串替换）。修改会先提交给用户做 Diff 审查，',
  '   只有用户接受后才会真正写入。',
  '3. 需要执行高危命令（如 rm、npm build 等 shell 命令）时调用工具 bash_execute {command}；',
  '   该调用需要用户审批后才能执行。',
  '4. 所有路径必须是工作区内的绝对路径；越界操作会被拒绝。',
  '5. 工具调用必须且只能使用如下格式输出（一个 fenced JSON 块，可含多个对象）：',
  '   ```toolcall',
  '   {"tool":"read_file","input":{"path":"..."}}',
  '   ```',
  '6. 工具执行结果会以 tool 角色消息回灌，你需要据此继续作答或发起下一轮工具调用。',
  '7. 最终给用户的正文应简洁、以中文为主，并给出关键结论。',
].join('\n');

export async function runRealAgent(
  ctx: AgentContext,
  params: SessionSendParams,
  config: RealAgentConfig
): Promise<void> {
  const { prompt, attachments = [] } = params;
  const maxRounds = config.maxToolRounds ?? 8;
  const abort = new AbortController();
  const caps: AgentCapabilities = ctx.capabilities ?? {};
  const trajectory = (kind: string, detail: string) =>
    ctx.notify(EVENTS.Trajectory, {
      sessionId: ctx.sessionId,
      step: ++stepCounter,
      kind,
      detail,
      ts: Date.now(),
    });

  ctx.notify(EVENTS.SessionStarted, { sessionId: ctx.sessionId, title: prompt.slice(0, 60) });
  trajectory('system', `session 开始（real agent）：${prompt.slice(0, 80)}`);

  const messages: ChatMessage[] = buildMessages(prompt, attachments);

  for (let round = 0; round < maxRounds; round++) {
    if (ctx.isCanceled()) break;

    let reasoning = '';
    let content = '';
    let streamFailed: Error | null = null;
    try {
      const result = await config.model.chat(messages, {
        signal: abort.signal,
        onChunk: (c) => {
          if (ctx.isCanceled() || abort.signal.aborted) {
            abort.abort();
            return;
          }
          if (c.type === 'reasoning') {
            ctx.notify(EVENTS.ReasoningDelta, { sessionId: ctx.sessionId, delta: c.text });
            trajectory('reasoning', c.text);
          } else {
            ctx.notify(EVENTS.MessageDelta, { sessionId: ctx.sessionId, delta: c.text });
          }
        },
      });
      reasoning = result.reasoning;
      content = result.content;
    } catch (err) {
      streamFailed = err instanceof Error ? err : new Error(String(err));
    }

    if (ctx.isCanceled() || abort.signal.aborted) break;
    if (streamFailed) {
      ctx.notify(EVENTS.Error, {
        sessionId: ctx.sessionId,
        code: ERROR_CODES.InternalError,
        message: `模型调用失败：${streamFailed.message}`,
      });
      ctx.notify(EVENTS.MessageDelta, { sessionId: ctx.sessionId, delta: '\n\n[错误] 模型请求失败，请检查 dsh.apiKey 与 dsh.model.* 配置。' });
      ctx.notify(EVENTS.SessionEnded, { sessionId: ctx.sessionId, reason: 'error', error: streamFailed.message });
      trajectory('system', 'session 错误（模型调用失败）');
      return;
    }

    ctx.notify(EVENTS.MessageDone, { sessionId: ctx.sessionId });

    const calls = parseToolCalls(content);
    if (calls.length === 0) break; // 无工具调用 => 最终回答已流式输出

    messages.push({ role: 'assistant', content });
    for (const call of calls) {
      if (ctx.isCanceled()) break;
      const toolOutput = await dispatchTool(ctx, call, caps, config, trajectory);
      messages.push({ role: 'tool', content: `tool=${call.tool}\n${toolOutput}` });
    }
  }

  const canceled = ctx.isCanceled();
  if (canceled) {
    ctx.notify(EVENTS.MessageDelta, { sessionId: ctx.sessionId, delta: '\n\n[已取消]' });
    ctx.notify(EVENTS.SessionEnded, { sessionId: ctx.sessionId, reason: 'canceled' });
  } else {
    ctx.notify(EVENTS.SessionEnded, { sessionId: ctx.sessionId, reason: 'completed' });
  }
  trajectory('system', `session 结束：${canceled ? 'canceled' : 'completed'}`);
}

// ---------------------------------------------------------------------------
// 工具分派
// ---------------------------------------------------------------------------

function toolAllowed(caps: AgentCapabilities, name: string): boolean {
  const tools = caps.allowedTools;
  return !tools || tools.length === 0 || tools.includes(name);
}

async function dispatchTool(
  ctx: AgentContext,
  call: ToolCall,
  caps: AgentCapabilities,
  config: RealAgentConfig,
  trajectory: (kind: string, detail: string) => void
): Promise<string> {
  const { tool, input } = call;
  const sessionId = ctx.sessionId;
  const allowedDirs = caps.allowedDirs ?? [];
  const start = Date.now();

  // ---- 只读：read_file / list_dir
  if (tool === 'read_file' || tool === 'list_dir') {
    if (!toolAllowed(caps, tool)) return disabledTool(ctx, sessionId, caps, tool);
    ctx.notify(EVENTS.ToolStarted, { sessionId, tool, input });
    trajectory('tool', `${tool} ${JSON.stringify(input)}`);
    try {
      if (tool === 'list_dir') {
        const { names } = listDirectory(ctx.workspaceRoot, allowedDirs, String(input.path ?? '.'));
        const output = names.length ? names.join('\n') : '(空目录)';
        ctx.notify(EVENTS.ToolExecuted, { sessionId, tool, ok: true, output, durationMs: Date.now() - start });
        trajectory('tool', `${tool} 完成`);
        return output;
      }
      const data = readTextFile(ctx.workspaceRoot, allowedDirs, String(input.path ?? ''), config.maxReadBytes ?? 64 * 1024);
      ctx.notify(EVENTS.ToolExecuted, { sessionId, tool, ok: true, output: data.content, durationMs: Date.now() - start });
      trajectory('tool', `${tool} 完成`);
      return data.content;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ctx.notify(EVENTS.ToolExecuted, { sessionId, tool, ok: false, output: msg, durationMs: Date.now() - start });
      trajectory('tool', `${tool} 失败：${msg}`);
      return `${tool} 失败：${msg}`;
    }
  }

  // ---- 修改：write_file / apply_patch（经 Diff 审查）
  if (tool === 'write_file' || tool === 'apply_patch') {
    if (!toolAllowed(caps, tool)) return disabledTool(ctx, sessionId, caps, tool);
    const target = String(input.path ?? '');
    let newContent: string;
    try {
      const resolved = resolveTarget(ctx.workspaceRoot, allowedDirs, target);
      const oldContent = tryReadFile(ctx.workspaceRoot, allowedDirs, target);
      if (tool === 'write_file') {
        newContent = String(input.content ?? '');
      } else {
        const search = String(input.search ?? '');
        const replace = String(input.replace ?? '');
        if (!search) throw new Error('apply_patch 需要 search 字段');
        if (!oldContent || !oldContent.includes(search)) throw new Error('apply_patch 的 search 未在原文件中找到');
        newContent = oldContent.split(search).join(replace);
      }

      const patchId = `patch_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      const patchPayload: EventFilePatchPending = {
        sessionId,
        patchId,
        path: resolved,
        oldContent,
        newContent,
        description: `Agent 提议${tool === 'write_file' ? '写入' : '修改'} ${path.basename(resolved)}`,
      };
      ctx.notify(EVENTS.FilePatchPending, patchPayload);
      trajectory('patch', `file.patch.pending ${resolved}`);

      const accepted = await ctx.waitForUser('patch', patchPayload);
      trajectory('patch', `file.patch.respond ${accepted ? 'accept' : 'reject'}`);

      let applied = false;
      let error: string | undefined;
      if (accepted) {
        try {
          writeTextFile(ctx.workspaceRoot, allowedDirs, resolved, newContent);
          applied = true;
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
        }
      }
      ctx.notify(EVENTS.FilePatchResult, { sessionId, patchId, accepted, applied, error });
      return accepted
        ? applied
          ? `已写入 ${resolved}`
          : `写入失败：${error}`
        : `用户拒绝了修改 ${resolved}`;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ctx.notify(EVENTS.Error, { sessionId, code: (e as { code?: number }).code, message: msg });
      return `${tool} 失败：${msg}`;
    }
  }

  // ---- 高危命令：bash_execute（审批 + 策略门控）
  if (tool === 'bash_execute' || tool === 'bash' || tool === 'run_command') {
    if (!toolAllowed(caps, 'bash_execute')) return disabledTool(ctx, sessionId, caps, 'bash_execute');
    const command = String(input.command ?? '');
    ctx.notify(EVENTS.ToolStarted, { sessionId, tool: 'bash_execute', input });
    trajectory('tool', `bash_execute ${JSON.stringify(input)}`);

    const decision = evaluateCommandPolicy(command, config.commandPolicy ?? {});
    if (!decision.allowed) {
      ctx.notify(EVENTS.ToolExecuted, {
        sessionId,
        tool: 'bash_execute',
        ok: false,
        output: `命令被策略拒绝：${decision.reason}`,
        durationMs: Date.now() - start,
      });
      trajectory('tool', `bash_execute 策略拒绝：${decision.reason}`);
      return `命令被策略拒绝：${decision.reason}`;
    }

    const approvalId = `approval_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const approvalParams: EventApprovalRequest = {
      sessionId,
      approvalId,
      tool: 'bash_execute',
      input: { command },
      risk: 'high',
      reason: `高危命令需要人工审批：${command.slice(0, 200)}`,
      expiresAt: Date.now() + 60_000,
    };
    ctx.notify(EVENTS.ApprovalRequest, approvalParams);
    trajectory('approval', 'approval.request bash_execute');

    const approved = await ctx.waitForUser('approval', approvalParams);
    trajectory('approval', `approval.respond ${approved ? 'approved' : 'rejected'}`);
    if (!approved) {
      ctx.notify(EVENTS.ToolExecuted, {
        sessionId,
        tool: 'bash_execute',
        ok: false,
        output: '已取消：用户拒绝了该命令。',
        durationMs: Date.now() - start,
      });
      return '已取消：用户拒绝了该命令。';
    }

    const run = await executeCommand(command, ctx.workspaceRoot, { timeoutMs: 30_000, runner: config.commandRunner });
    ctx.notify(EVENTS.ToolExecuted, { sessionId, tool: 'bash_execute', ok: run.ok, output: run.output, durationMs: run.durationMs });
    trajectory('tool', 'bash_execute 完成');
    return run.output;
  }

  // 未知工具
  ctx.notify(EVENTS.ToolExecuted, {
    sessionId,
    tool,
    ok: false,
    output: `未知工具：${tool}`,
    durationMs: 0,
  });
  return `未知工具：${tool}`;
}

function disabledTool(ctx: AgentContext, sessionId: string, caps: AgentCapabilities, tool: string): string {
  const msg = `工具 ${tool} 被禁用：capabilities.allowedTools 未包含 ${tool}。`;
  ctx.notify(EVENTS.ToolStarted, { sessionId, tool, input: {} });
  ctx.notify(EVENTS.ToolExecuted, { sessionId, tool, ok: false, output: msg, durationMs: 0 });
  return msg;
}

// ---------------------------------------------------------------------------
// 消息构建
// ---------------------------------------------------------------------------

function buildMessages(prompt: string, attachments: SessionSendParams['attachments']): ChatMessage[] {
  const parts: string[] = [`用户请求：\n${prompt}`];
  for (const a of attachments ?? []) {
    switch (a.kind) {
      case 'file':
        parts.push(
          `\n<file path="${a.path ?? ''}" name="${a.name ?? ''}" language="${a.language ?? ''}">\n` +
            (a.contentOmitted ? '<!-- 内容过大已省略，请用 read_file 工具读取 -->' : (a.content ?? '')) +
            '\n</file>'
        );
        break;
      case 'selection':
        parts.push(`\n<selection path="${a.path ?? ''}">\n${a.content ?? ''}\n</selection>`);
        break;
      case 'diagnostics':
        parts.push(`\n<diagnostics>${JSON.stringify(a.diagnostics ?? [])}</diagnostics>`);
        break;
      case 'gitStatus':
        parts.push(`\n<git-status>\n${a.gitStatus ?? ''}\n</git-status>`);
        break;
      case 'text':
        parts.push(`\n<text>${a.text ?? ''}</text>`);
        break;
    }
  }
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: parts.join('\n') },
  ];
}