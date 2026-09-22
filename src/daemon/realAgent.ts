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
import { ChatMessage, ChatModel, ToolDefinition } from './model';
import { parseToolCalls, ToolCall } from './toolcall';
import {
  CommandPolicy,
  CommandRunner,
  evaluateCommandPolicy,
  executeCommand,
  FileRangeResult,
  globFiles,
  GrepResult,
  grepFiles,
  listDirectory,
  MAX_RANGE_FILE_BYTES,
  resolveTarget,
  sliceLines,
} from './tools';
import { applyPatchDecision, describePatchOutcome } from './patchApply';
import { makePatchEnv } from './agent';
import { CommandSandbox } from './sandbox';

export interface RealAgentConfig {
  model: ChatModel;
  /** 高危命令策略；无论是否配置，内置高危拒绝规则（DEFAULT_DENY_PATTERNS）都会生效 */
  commandPolicy?: CommandPolicy;
  /** 命令执行器（测试注入；缺省 child_process） */
  commandRunner?: CommandRunner;
  /** 工具调用轮数上限，防止死循环 */
  maxToolRounds?: number;
  /** 工具读取单文件上限（字节） */
  maxReadBytes?: number;
  /** 上下文 token 预算（发送前裁剪历史，防止超出模型上下文窗口） */
  maxContextTokens?: number;
  /** 模型请求空闲超时（ms，P0-3）：距上一增量超过该时长即中断；<= 0 关闭。缺省 60s。 */
  idleTimeoutMs?: number;
  /** 命令沙箱（P3.5+）：可选，缺省 executeCommand 内部兜底 ProcessSandbox */
  sandbox?: CommandSandbox;
}

let stepCounter = 0;

const SYSTEM_PROMPT = [
  '你是 dsh，运行在 VSCode 扩展中的编程智能体。你通过工具与工作区交互，并遵守以下规则：',
  '',
  '1. 需要读取文件时调用工具 read_file（配合 grep 定位的 文件:行号，用 startLine/endLine 精读片段）；',
  '   列出目录调用 list_dir；按文件名定位文件调用 glob（如 `*.ts`）；跨文件搜索关键字调用 grep。',
  '   以上三类只读工具均无需审批。',
  '2. 需要修改/创建文件时，不要直接写盘，而是调用工具 write_file {path, content}（全量覆盖）',
  '   或 apply_patch {path, search, replace}（字符串替换）。修改会先提交给用户做 Diff 审查，',
  '   只有用户接受后才会真正写入。',
  '3. 需要执行高危命令（如 rm、npm build 等 shell 命令）时调用工具 bash_execute {command}；',
  '   该调用需要用户审批后才能执行。',
  '4. 所有路径必须是工作区内的绝对路径；越界操作会被拒绝。',
  '5. 调用工具时优先使用原生 function calling（工具定义已随请求提供）；若需以文本形式表达，',
  '   输出 fenced JSON 块（```toolcall 或 ```json 均可，块内为单个 JSON 对象或对象数组）：',
  '   ```toolcall',
  '   {"tool":"read_file","input":{"path":"..."}}',
  '   ```',
  '6. 工具执行结果会以 tool 角色消息回灌，你需要据此继续作答或发起下一轮工具调用。',
  '7. 最终给用户的正文应简洁、以中文为主，并给出关键结论。',
].join('\n');

/** 暴露给模型的原生工具清单（JSON Schema；与 dispatchTool 支持的工具一一对应）。 */
const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'read_file',
    description: '读取工作区内的文本文件（可用 startLine/endLine 精读片段，缺省读全文）',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '工作区内的绝对路径' },
        startLine: { type: 'number', description: '起始行（1-based，可选；配合 endLine 精读片段）' },
        endLine: { type: 'number', description: '结束行（1-based 含，可选）' },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_dir',
    description: '列出目录内容',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '目录路径（缺省为工作区根）' } },
    },
  },
  {
    name: 'grep',
    description: '跨文件搜索包含指定关键字/符号的行（无需审批的只读工具，跳过 node_modules/.git 与二进制、超大文件）',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '要搜索的字面量关键字' },
        path: { type: 'string', description: '搜索目录（缺省为工作区根）' },
        include: { type: 'string', description: '文件名过滤通配（如 *.ts，可选）' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'glob',
    description: '按文件名通配符定位文件（无需审批的只读工具，跳过 node_modules/.git）',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '文件名通配（如 *.ts、test*）' },
        path: { type: 'string', description: '搜索目录（缺省为工作区根）' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'write_file',
    description: '写入/覆盖文件（提交用户 Diff 审查后应用）',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '工作区内绝对路径' },
        content: { type: 'string', description: '文件完整内容' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'apply_patch',
    description: '字符串替换修改文件（提交用户 Diff 审查后应用）',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '工作区内绝对路径' },
        search: { type: 'string', description: '待替换的原字符串' },
        replace: { type: 'string', description: '替换后的新字符串' },
      },
      required: ['path', 'search', 'replace'],
    },
  },
  {
    name: 'bash_execute',
    description: '执行 shell 命令（高危，需用户审批）',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: '要执行的命令' } },
      required: ['command'],
    },
  },
];

export async function runRealAgent(
  ctx: AgentContext,
  params: SessionSendParams,
  config: RealAgentConfig
): Promise<void> {
  const { prompt, attachments = [] } = params;
  const maxRounds = config.maxToolRounds ?? 8;
  const abort = new AbortController();
  const caps: AgentCapabilities = ctx.capabilities ?? {};
  // P0-3：订阅会话取消，在途模型请求可被立即中断（不必等 onChunk 才察觉取消）
  const unsubscribeCancel = ctx.onCancel?.(() => abort.abort());
  const trajectory = (kind: string, detail: string) =>
    ctx.notify(EVENTS.Trajectory, {
      sessionId: ctx.sessionId,
      step: ++stepCounter,
      kind,
      detail,
      ts: Date.now(),
    });

  const title = ctx.isCanceled() ? prompt.slice(0, TITLE_MAX) : await generateTitle(config.model, prompt);
  ctx.notify(EVENTS.SessionStarted, { sessionId: ctx.sessionId, title });
  trajectory('system', `session 开始（real agent）：${prompt.slice(0, 80)}`);

  const messages: ChatMessage[] = buildMessages(prompt, attachments);
  const maxContextTokens = config.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;

  for (let round = 0; round < maxRounds; round++) {
    if (ctx.isCanceled()) break;

    let reasoning = '';
    let content = '';
    let nativeToolCalls: ToolCall[] | undefined;
    let streamFailed: Error | null = null;
    try {
      const trimmed = applyTokenBudget(messages, maxContextTokens);
      if (trimmed.length < messages.length) {
        trajectory('system', `上下文裁剪：${messages.length} → ${trimmed.length} 条消息（预算 ${maxContextTokens} token）`);
        // 就地收缩：丢弃已裁剪掉的最旧轮次，避免完整历史（含大 tool 输出）随轮次累积占用内存
        messages.length = 0;
        messages.push(...trimmed);
      }
      const result = await config.model.chat(messages, {
        signal: abort.signal,
        idleTimeoutMs: config.idleTimeoutMs,
        tools: TOOL_DEFINITIONS,
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
      nativeToolCalls = result.toolCalls;
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

    // 原生 function calling 优先；无原生调用时兜底解析 fenced 文本
    const calls = nativeToolCalls && nativeToolCalls.length > 0 ? nativeToolCalls : parseToolCalls(content);
    if (calls.length === 0) break; // 无工具调用 => 最终回答已流式输出

    messages.push({ role: 'assistant', content, toolCalls: nativeToolCalls });
    for (const call of calls) {
      if (ctx.isCanceled()) break;
      const toolOutput = await dispatchTool(ctx, call, caps, config, trajectory);
      messages.push({ role: 'tool', content: `tool=${call.tool}\n${toolOutput}`, toolCallId: call.id });
    }
  }

  const canceled = ctx.isCanceled();
  unsubscribeCancel?.();
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

  // ---- 只读：read_file / list_dir / grep / glob
  if (tool === 'read_file' || tool === 'list_dir' || tool === 'grep' || tool === 'glob') {
    if (!toolAllowed(caps, tool)) return disabledTool(ctx, sessionId, caps, tool);
    ctx.notify(EVENTS.ToolStarted, { sessionId, tool, input });
    trajectory('tool', `${tool} ${JSON.stringify(input)}`);
    try {
      let output: string;
      if (tool === 'list_dir') {
        const { names } = listDirectory(ctx.workspaceRoot, allowedDirs, String(input.path ?? ''));
        output = names.length ? names.join('\n') : '(空目录)';
      } else if (tool === 'grep') {
        const res = grepFiles(ctx.workspaceRoot, allowedDirs, String(input.pattern ?? ''), {
          dir: String(input.path ?? ''),
          include: input.include ? String(input.include) : undefined,
        });
        output = formatGrepResult(res);
      } else if (tool === 'glob') {
        const res = globFiles(ctx.workspaceRoot, allowedDirs, String(input.pattern ?? ''), {
          dir: String(input.path ?? ''),
        });
        output = res.files.length
          ? res.files.join('\n') + (res.truncated ? '\n…（结果过多已截断）' : '')
          : '(无匹配文件)';
      } else if (tool === 'read_file') {
        // P0-1：脏文档优先——命中编辑器未保存缓冲区就返回缓冲区内容，未命中回落磁盘。
        // 若这里读磁盘而模型上下文里是缓冲区，模型会基于"它以为的最新内容"推理、却拿到旧内容。
        // 行号精读（startLine/endLine）同样建立在「有效内容」之上：先取覆盖层优先的文本再切片，
        // 否则 dirty 时 grep 定位到的行号会指向磁盘上的过期内容。
        const target = String(input.path ?? '');
        const startLine = typeof input.startLine === 'number' ? input.startLine : undefined;
        const endLine = typeof input.endLine === 'number' ? input.endLine : undefined;
        const wantRange = startLine !== undefined || endLine !== undefined;
        const content = await ctx.readFile(
          target,
          wantRange ? MAX_RANGE_FILE_BYTES : config.maxReadBytes ?? 64 * 1024
        );
        if (content === undefined) throw new Error('无法读取：路径越界或文件不存在');
        output = wantRange
          ? formatFileRange(target, sliceLines(content.split('\n'), { startLine, endLine }))
          : content;
        if (ctx.isDirty?.(target)) output += '\n\n（注：以上为该文件在编辑器中的未保存内容）';
      } else {
        // 外层条件已限定为四种只读工具之一，正常不可达；保留以满足穷尽性检查。
        throw new Error(`未知只读工具：${tool}`);
      }
      ctx.notify(EVENTS.ToolExecuted, { sessionId, tool, ok: true, output, durationMs: Date.now() - start });
      trajectory('tool', `${tool} 完成`);
      return output;
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
      // P0-1：基准内容取「编辑器未保存缓冲区优先」——与模型在上下文里看到的内容同源，
      // 否则 diff 的 old 侧会是过期磁盘内容，用户看到的对比就是错的。
      const oldContent = await ctx.readFile(resolved);
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

      // P0-1 / P0-2 / P2 统一落地裁决（脏文档走编辑器、普通文件走乐观锁）
      const result = accepted
        ? applyPatchDecision(makePatchEnv(ctx), { patchId, resolvedPath: resolved, oldContent, newContent })
        : { applied: false, appliedInEditor: false };
      ctx.notify(EVENTS.FilePatchResult, {
        sessionId,
        patchId,
        accepted,
        applied: result.applied,
        error: result.error,
        appliedInEditor: result.appliedInEditor || undefined,
      });
      return accepted ? describePatchOutcome(result, resolved) : `用户拒绝了修改 ${resolved}`;
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
      // expiresAt 由 daemon 按 approvalTtlMs 统一盖戳（见 server.ts notify）
    };
    // B1 信任记忆：命中白名单 -> 免审批直接执行（不发起 approval.request）
    if (ctx.isTrusted?.(command)) {
      const run = await executeCommand(command, ctx.workspaceRoot, { timeoutMs: 30_000, runner: config.commandRunner, sandbox: config.sandbox });
      ctx.notify(EVENTS.ToolExecuted, {
        sessionId,
        tool: 'bash_execute',
        ok: run.ok,
        output: run.output,
        durationMs: run.durationMs,
        trusted: true,
      });
      trajectory('tool', `bash_execute 命中信任规则，免审批（${run.ok ? 'ok' : '失败'}）`);
      return run.output;
    }
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

    const run = await executeCommand(command, ctx.workspaceRoot, { timeoutMs: 30_000, runner: config.commandRunner, sandbox: config.sandbox });
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

function formatFileRange(filePath: string, r: FileRangeResult): string {
  return `（${filePath} 共 ${r.totalLines} 行，显示第 ${r.startLine}-${r.endLine} 行）\n${r.content}`;
}

function formatGrepResult(res: GrepResult): string {
  if (res.matches.length === 0) return '(无匹配)';
  const lines = res.matches.map((m) => `${m.file}:${m.line}: ${m.text}`);
  if (res.truncated) lines.push('…（匹配过多已截断）');
  return lines.join('\n');
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

// ---------------------------------------------------------------------------
// 标题生成
// ---------------------------------------------------------------------------

/** 标题最大长度（与 sessionHistory 的截断同值，保持一致）。 */
const TITLE_MAX = 40;

/** 标题生成用的 system 提示（测试据此识别标题生成请求）。 */
export const TITLE_SYSTEM_PROMPT =
  '你是标题生成器。根据用户的请求生成一个不超过 40 字的中文标题，直接输出标题本身，不要解释、标点或引号。';

/** 用模型把用户请求总结成简洁标题（≤40 字）；失败 / 空 / 超时（5s）兜底 prompt 前 40 字。 */
export async function generateTitle(model: ChatModel, prompt: string): Promise<string> {
  const fallback = prompt.slice(0, TITLE_MAX);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 5000);
  try {
    const result = await model.chat(
      [
        { role: 'system', content: TITLE_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      { signal: abort.signal, idleTimeoutMs: 0 } // 标题生成已由外层 5s 定时器兜底
    );
    const t = (result.content ?? '').replace(/\s+/g, ' ').trim();
    return t ? t.slice(0, TITLE_MAX) : fallback;
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// 上下文 token 预算
// ---------------------------------------------------------------------------

/** 默认上下文预算（token）：为 DeepSeek 64K 窗口留出输出与余量。 */
const DEFAULT_MAX_CONTEXT_TOKENS = 48 * 1024;

/** 宽字符（CJK 汉字、平/片假名、注音符号、CJK 标点与全角）范围，约 1 token/字。 */
const CJK_RE = /[\u3040-\u30ff\u3100-\u312f\u31a0-\u31bf\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/g;

/** 粗略估算 token（宽字符约 1 token，其余约 4 字符/token）；用于预算裁剪，非精确计数。 */
export function estimateTokens(text: string): number {
  const cjk = (text.match(CJK_RE) || []).length;
  return Math.ceil(cjk + (text.length - cjk) / 4);
}

function estimateMessageTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += estimateTokens(m.content);
    if (m.toolCalls) total += estimateTokens(JSON.stringify(m.toolCalls));
  }
  return total;
}

/**
 * 上下文预算裁剪：超出 maxTokens 时从最旧的工具轮次（assistant + 紧随的 tool 结果）
 * 整轮向前丢弃，保留 system + 初始 user + 最近轮次；整轮裁剪不拆散原生 toolCalls/toolCallId 配对。
 */
export function applyTokenBudget(messages: ChatMessage[], maxTokens: number): ChatMessage[] {
  if (estimateMessageTokens(messages) <= maxTokens || messages.length <= 2) return messages;
  // 不变量：[0]=system，[1]=user(初始)，[2]=assistant（首轮，其后为 tool* 轮次序列）；非此结构不裁剪（防御外部误用）
  if (messages[0].role !== 'system' || messages[1].role !== 'user' || messages[2]?.role !== 'assistant') return messages;
  const copy = messages.slice();
  while (copy.length > 2 && estimateMessageTokens(copy) > maxTokens) {
    let end = 3;
    while (end < copy.length && copy[end].role === 'tool') end++;
    copy.splice(2, end - 2);
  }
  return copy;
}
