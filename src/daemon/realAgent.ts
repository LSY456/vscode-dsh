/**
 * 真实 Agent 循环（P3.2）。
 *
 * 与 runFakeAgent 实现完全相同的 AgentContext 契约，因此 server 侧只需换一行调用。
 * 行为：模型流式推理/回答（reasoning.delta / message.delta）→ 解析工具调用 →
 * 分派真实工具（路径护栏 + 审批门控）→ 回灌工具结果 → 继续，直至不再调用工具或取消。
 */
import {
  DEFAULT_MAX_CONTEXT_TOKENS,
  DEFAULT_MAX_TOOL_ROUNDS,
  EVENTS,
  ERROR_CODES,
  EventApprovalRequest,
  EventFilePatchPending,
  SessionSendParams,
} from '../../shared/protocol';
import * as path from 'path';
import { AgentCapabilities, AgentContext } from './agent';
import { ChatMessage, ChatModel, StreamChunk, ToolDefinition } from './model';
import { createToolCallFenceFilter, parseToolCalls, ToolCall, ToolCallFenceFilter } from './toolcall';
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
  /** 采样温度（0–2）；undefined = 沿用模型层缺省，即不改动既有行为 */
  temperature?: number;
  /** 单次输出上限（max_tokens）；undefined / <= 0 = 不发送该字段，由服务端决定 */
  maxTokens?: number;
  /** 命令沙箱（P3.5+）：可选，缺省 executeCommand 内部兜底 ProcessSandbox */
  sandbox?: CommandSandbox;
}

/**
 * 无 `ctx.nextStep` 时的兜底计数器（测试里构造的裸 context 才会走到）。
 *
 * 生产路径下步号一律由**会话**提供：模块级全局计数在多会话并发时会互相穿插，
 * 而 PROTOCOL 把 `step` 定义为"会话内单调递增" —— 表现就是 UI 的执行迹线跳号（P1-8）。
 */
let fallbackStepCounter = 0;

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
  '   该调用需要用户审批后才能执行。浏览目录 / 查看文件 / 搜索代码请一律使用上面的只读工具，',
  '   **不要用 bash_execute（ls、dir、cat）代替**——那样每次都要用户审批，且会多占一轮工具调用。',
  '4. 路径可以写工作区内的绝对路径，也可以写相对工作区的路径',
  '   （如 `.`、`src`、`src/daemon/tools.ts`）；越界操作会被拒绝。省略 path 表示工作区根。',
  '5. 调用工具时优先使用原生 function calling（工具定义已随请求提供）；若需以文本形式表达，',
  '   输出 fenced JSON 块（```toolcall 或 ```json 均可，块内为单个 JSON 对象或对象数组）：',
  '   ```toolcall',
  '   {"tool":"read_file","input":{"path":"..."}}',
  '   ```',
  '6. 工具执行结果会以 tool 角色消息回灌，你需要据此继续作答或发起下一轮工具调用。',
  '7. 最终给用户的正文应简洁、以中文为主，并给出关键结论。',
  '8. 工具调用轮次有上限：请用最少的调用拿到"足以作答"的信息，不要为追求穷尽而反复试探；',
  '   轮次用尽后你只能基于已有信息收尾，因此每轮都要为"万一到此为止"留好结论。',
].join('\n');

/** 暴露给模型的原生工具清单（JSON Schema；与 dispatchTool 支持的工具一一对应）。 */
const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'read_file',
    description: '读取工作区内的文本文件（可用 startLine/endLine 精读片段，缺省读全文）',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '文件路径：工作区内绝对路径，或相对工作区的路径（如 src/daemon/tools.ts）',
        },
        startLine: { type: 'number', description: '起始行（1-based，可选；配合 endLine 精读片段）' },
        endLine: { type: 'number', description: '结束行（1-based 含，可选）' },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_dir',
    description: '列出目录内容（浏览目录请用本工具，不要用 bash_execute 的 ls/dir）',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '目录路径：相对工作区（如 src、`src/daemon`；`.` 表示工作区根）或绝对路径；缺省为工作区根',
        },
      },
    },
  },
  {
    name: 'grep',
    description:
      '跨文件搜索匹配的行（无需审批的只读工具，跳过 node_modules/.git 与二进制、超大文件）。' +
      'pattern 按正则解析，用 | 可多选一（如 resolveTarget|assertPathInside）。',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: '正则表达式（如 "resolveTarget|assertPathInside"、"async function"）',
        },
        path: { type: 'string', description: '搜索目录：相对工作区或绝对路径；缺省为工作区根' },
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
        path: { type: 'string', description: '搜索目录：相对工作区或绝对路径；缺省为工作区根' },
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
  // 缺省值取自协议里的单一来源（此前这里硬写 8，与 shared/protocol 各存一份，属同类漂移隐患）
  const maxRounds = config.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
  const abort = new AbortController();
  const caps: AgentCapabilities = ctx.capabilities ?? {};
  // P0-3：订阅会话取消，在途模型请求可被立即中断（不必等 onChunk 才察觉取消）
  const unsubscribeCancel = ctx.onCancel?.(() => abort.abort());
  const trajectory = (kind: string, detail: string) =>
    ctx.notify(EVENTS.Trajectory, {
      sessionId: ctx.sessionId,
      // 步号优先取**会话**计数（会话内单调递增）；只有裸 context 才回落到进程内兜底
      step: ctx.nextStep?.() ?? ++fallbackStepCounter,
      kind,
      detail,
      ts: Date.now(),
    });

  const title = ctx.isCanceled() ? prompt.slice(0, TITLE_MAX) : await generateTitle(config.model, prompt);
  ctx.notify(EVENTS.SessionStarted, { sessionId: ctx.sessionId, title });
  trajectory('system', `session 开始（real agent）：${prompt.slice(0, 80)}`);

  const messages: ChatMessage[] = buildMessages(prompt, attachments);
  const maxContextTokens = config.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;

  /**
   * 展示层围栏过滤器（见下方 streamChunk 的说明）。
   *
   * 只影响**推给面板的增量**，不影响回灌给模型的 `content`；`null` = 不过滤
   * （收束请求不提供工具，此时正文里的围栏是内容而非调用）。
   */
  let fenceFilter: ToolCallFenceFilter | null = null;

  /**
   * 每个增量到达时的统一投影（推理 / 正文分流）。
   * 收束请求复用同一条通路，保证流式渲染与结束时的定妆完全一致。
   *
   * 正文增量会先过一遍围栏过滤器：模型把工具调用写在正文里（```toolcall / ```json），
   * 原样推出的话每轮调用的原始 JSON 会永久留在答案气泡里，还会被扩展写进 `.dsh/history.json`。
   * 过滤器只吞「确实解析成工具调用」的块（见 toolcall.ts），代码块与普通 JSON 不受影响。
   */
  const streamChunk = (c: StreamChunk) => {
    if (ctx.isCanceled() || abort.signal.aborted) {
      abort.abort();
      return;
    }
    if (c.type === 'reasoning') {
      ctx.notify(EVENTS.ReasoningDelta, { sessionId: ctx.sessionId, delta: c.text });
      trajectory('reasoning', c.text);
    } else {
      const visible = fenceFilter ? fenceFilter.push(c.text) : c.text;
      if (visible) ctx.notify(EVENTS.MessageDelta, { sessionId: ctx.sessionId, delta: visible });
    }
  };

  /**
   * 把过滤器缓冲里剩下的正文吐出去（轮末调用）。
   *
   * 必须显式收尾：未闭合的围栏在流结束时要按原样展示，否则模型的坏输出会被静默吞掉，
   * 用户只看到半句话，反而更难诊断。`flush` 后再换新过滤器，保证轮与轮之间不串。
   */
  const flushVisibleText = () => {
    if (!fenceFilter) return;
    const tail = fenceFilter.flush();
    if (tail) ctx.notify(EVENTS.MessageDelta, { sessionId: ctx.sessionId, delta: tail });
  };

  /** 轮次耗尽时追加的指令：明确"不要再调工具"，逼模型用已收集的信息给结论。 */
  const FINAL_ANSWER_INSTRUCTION =
    '（系统提示）工具调用轮次已达上限，不能再调用任何工具。请立即基于上面已经获得的信息，' +
    '直接给出最终结论（中文、简洁，含关键判断与依据）。若信息仍不足以回答，请明确说明还缺什么、' +
    '下一步该看哪里；不要输出任何工具调用格式。';

  /** 收束请求本身失败 / 仍没有正文时的兜底告知——绝不静默收场。 */
  const exhaustedNotice = () =>
    `\n\n> ⚠️ 工具调用已达上限（${maxRounds} 轮），未能生成完整结论。` +
    '上方「过程」里保留了已完成的步骤；你可以直接再发一条消息让我继续，' +
    '或把问题收窄一些（例如指定具体文件）以便更快作答。\n\n';

  /**
   * 收束回答：轮次用尽后追加一条"不要再调工具"的指令，并且**不提供工具定义**，
   * 让模型用已收集的信息给出最终结论。
   *
   * 为什么非有这一步不可：主循环在轮次耗尽时只是退出 `for`，随后直接报 `completed`。
   * 而工具调用轮里模型的正文通常只有一句"我先看看…"，于是用户看到的是一屏工具行加半句
   * 开场白，然后会话"自动中断"、什么结论都没有——这正是「agent 并没有返回任何信息、
   * 也不明确执行到哪一步」的根因。
   */
  const requestFinalAnswer = async (): Promise<boolean> => {
    // 收束请求刻意不提供工具：此时正文里若出现 fenced 块，它是**内容**（用户可能就是在问
    // 工具调用格式），而不是一次调用 —— 所以这里必须关掉过滤器。
    fenceFilter = null;
    trajectory('system', `工具轮次已达上限（${maxRounds} 轮），转为收束回答（不再提供工具）`);
    messages.push({ role: 'user', content: FINAL_ANSWER_INSTRUCTION });
    try {
      const result = await config.model.chat(messages, {
        signal: abort.signal,
        idleTimeoutMs: config.idleTimeoutMs,
        temperature: config.temperature,
        maxTokens: config.maxTokens,
        // 刻意不传 tools：模型无法再发起工具调用，只能作答。
        onChunk: streamChunk,
      });
      if (ctx.isCanceled() || abort.signal.aborted) return true; // 取消由调用方另行判定
      ctx.notify(EVENTS.MessageDone, { sessionId: ctx.sessionId });
      if (!(result.content ?? '').trim()) {
        ctx.notify(EVENTS.MessageDelta, { sessionId: ctx.sessionId, delta: exhaustedNotice() });
      }
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[dsh-daemon] 收束回答失败（session=${ctx.sessionId}）：${msg}`);
      ctx.notify(EVENTS.Error, {
        sessionId: ctx.sessionId,
        code: ERROR_CODES.InternalError,
        message: `收束回答失败：${msg}`,
      });
      ctx.notify(EVENTS.MessageDelta, { sessionId: ctx.sessionId, delta: exhaustedNotice() });
      // 返回 false 让调用方以 reason=error 收尾：已经报了 error，却宣称"已完成"是自相矛盾的，
      // 而"会话为什么结束"正是用户最需要看懂的信息。
      return false;
    }
  };

  /** 模型是否自己收的尾（不再调用工具 => 已有最终回答）。false 即轮次被耗尽。 */
  let concludedByModel = false;

  for (let round = 0; round < maxRounds; round++) {
    if (ctx.isCanceled()) break;

    let reasoning = '';
    let content = '';
    let nativeToolCalls: ToolCall[] | undefined;
    let streamFailed: Error | null = null;
    // 每轮独立一个过滤器：上一轮的缓冲已在轮末 flush，不跨轮复用（否则上一轮残留的
    // 半截围栏会吃掉本轮正文）。
    fenceFilter = createToolCallFenceFilter();

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
        temperature: config.temperature,
        maxTokens: config.maxTokens,
        tools: TOOL_DEFINITIONS,
        onChunk: streamChunk,
      });
      reasoning = result.reasoning;
      content = result.content;
      nativeToolCalls = result.toolCalls;
    } catch (err) {
      streamFailed = err instanceof Error ? err : new Error(String(err));
    }

    // 轮末收尾过滤器：先于 message.done（面板据此定妆当前气泡），也覆盖上面的失败分支
    flushVisibleText();

    if (ctx.isCanceled() || abort.signal.aborted) break;
    if (streamFailed) {
      // 真机排查：daemon.log 此前只有启动行，模型失败的真实原因（HTTP 状态 / 上游原文）
      // 既不落盘也不进会话历史，事后完全无法诊断。这里 console.error 会被 logFile 的 tee
      // 镜像到 <workspace>/.dsh/logs/daemon.log。
      console.error(
        `[dsh-daemon] 模型调用失败（session=${ctx.sessionId}，第 ${round + 1}/${maxRounds} 轮）：${streamFailed.message}`
      );
      ctx.notify(EVENTS.Error, {
        sessionId: ctx.sessionId,
        code: ERROR_CODES.InternalError,
        message: `模型调用失败：${streamFailed.message}`,
      });
      // 这里只做"本轮已中止"的收束，不重复转述原因、更不做配置层面的猜测：
      // 具体原因由上面的 error 事件给出（model.ts 已按 HTTP 状态翻译成人话）。
      // 曾经这里硬写"请检查 apiKey 与 model 配置"，而上游返回 402 余额不足时，
      // 与配置毫无关系的这句话会把用户引到错误的排查方向。
      ctx.notify(EVENTS.MessageDelta, { sessionId: ctx.sessionId, delta: '\n\n[本轮已中止]' });
      ctx.notify(EVENTS.SessionEnded, { sessionId: ctx.sessionId, reason: 'error', error: streamFailed.message });
      trajectory('system', 'session 错误（模型调用失败）');
      return;
    }

    ctx.notify(EVENTS.MessageDone, { sessionId: ctx.sessionId });

    // 原生 function calling 优先；无原生调用时兜底解析 fenced 文本
    const calls = nativeToolCalls && nativeToolCalls.length > 0 ? nativeToolCalls : parseToolCalls(content);
    if (calls.length === 0) {
      concludedByModel = true; // 无工具调用 => 最终回答已流式输出
      break;
    }

    messages.push({ role: 'assistant', content, toolCalls: nativeToolCalls });
    for (const call of calls) {
      if (ctx.isCanceled()) break;
      const toolOutput = await dispatchTool(ctx, call, caps, config, trajectory);
      messages.push({ role: 'tool', content: `tool=${call.tool}\n${toolOutput}`, toolCallId: call.id });
    }
  }

  // 收束阶段之前也要能感知取消，所以取消订阅推迟到真正收尾时再解绑。
  if (ctx.isCanceled() || abort.signal.aborted) {
    unsubscribeCancel?.();
    ctx.notify(EVENTS.MessageDelta, { sessionId: ctx.sessionId, delta: '\n\n[已取消]' });
    ctx.notify(EVENTS.SessionEnded, { sessionId: ctx.sessionId, reason: 'canceled' });
    trajectory('system', 'session 结束：canceled');
    return;
  }

  const finalAnswerOk = concludedByModel ? true : await requestFinalAnswer();

  unsubscribeCancel?.();
  if (ctx.isCanceled() || abort.signal.aborted) {
    // 收束期间被取消：按取消收尾，不报 completed（避免"看起来成功了"）
    ctx.notify(EVENTS.MessageDelta, { sessionId: ctx.sessionId, delta: '\n\n[已取消]' });
    ctx.notify(EVENTS.SessionEnded, { sessionId: ctx.sessionId, reason: 'canceled' });
    trajectory('system', 'session 结束：canceled');
    return;
  }
  ctx.notify(EVENTS.SessionEnded, {
    sessionId: ctx.sessionId,
    reason: finalAnswerOk ? 'completed' : 'error',
  });
  trajectory('system', `session 结束：${finalAnswerOk ? 'completed' : 'error（收束回答失败）'}`);
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
          : res.walkExhausted
            ? '(搜索未完成：目录遍历超出预算，无法断言"无匹配文件"，请缩小 path 或缩小通配范围)'
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
  if (res.matches.length === 0) {
    // 遍历被预算截断时，"无匹配"不是一个可以下的结论 —— 必须说清是"没搜完"，
    // 否则模型会把"搜索被截断"读成"代码里没有这个符号"，接着反复换模式重试。
    if (res.walkExhausted) {
      return '(搜索未完成：目录遍历超出预算，无法断言"无匹配"，请缩小 path 或加 include 过滤)';
    }
    // 把正则语义写进返回值：早期实现只做字面量匹配，模型常因 `a|b|c` 无结果而误判
    // "代码里没有这个符号"，接着连续换模式重试（一轮能连错五次）。这句提示直接掐掉那串重试。
    return '(无匹配：pattern 按正则解析，可用 | 做多选一，或先用 glob 确认文件是否存在)';
  }
  const lines = res.matches.map((m) => `${m.file}:${m.line}: ${m.text}`);
  if (res.walkExhausted) {
    lines.push('…（结果不完整：目录遍历超出预算，请缩小 path 或加 include 过滤）');
  } else if (res.truncated) {
    lines.push('…（匹配过多已截断）');
  }
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
      { signal: abort.signal, idleTimeoutMs: 0, maxRetries: 0 } // 标题生成已由外层 5s 定时器兜底
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

// 上下文预算的缺省值收在 `shared/protocol.ts`（扩展与 daemon 共用）——
// 这里原先还留着一份本地 48K 拷贝，数值虽相同，却是"第二份真相"，一并删掉。

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
