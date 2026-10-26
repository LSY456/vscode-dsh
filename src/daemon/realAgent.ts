/**
 * 真实 Agent 循环（P3.2）。
 *
 * 与 runFakeAgent 实现完全相同的 AgentContext 契约，因此 server 侧只需换一行调用。
 * 行为：模型流式推理/回答（reasoning.delta / message.delta）→ 解析工具调用 →
 * 分派真实工具（路径护栏 + 审批门控）→ 回灌工具结果 → 继续，直至不再调用工具或取消。
 */
import {
  Attachment,
  DEFAULT_MAX_CONTEXT_TOKENS,
  DEFAULT_MAX_TOOL_ROUNDS,
  DEFAULT_MAX_WRITE_FAILURES,
  DEFAULT_PLAN_MAX_ROUNDS,
  EVENTS,
  ERROR_CODES,
  EventApprovalRequest,
  EventFilePatchPending,
  EventPlanRequest,
  SessionSendParams,
  TrajectoryErrorKind,
} from '../../shared/protocol';
import { sanitizeImageAttachments } from '../../shared/imageAttachment';
import * as path from 'path';
import { AgentCapabilities, AgentContext } from './agent';
import { ChatContentPart, ChatMessage, ChatModel, contentToText, StreamChunk, ToolDefinition } from './model';
import { TrajectoryMeta } from '../../shared/protocol';
import { createToolCallFenceFilter, parseToolCalls, ToolCall, ToolCallFenceFilter } from './toolcall';
import {
  classifyCommandRisk,
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
  riskReason,
  sliceLines,
} from './tools';
import { applyPatchDecision, describePatchOutcome } from './patchApply';
import { makePatchEnv } from './agent';
import {
  PLAN_COLLAPSE_INSTRUCTION,
  PLAN_SYSTEM_APPENDIX,
  planApprovedInstruction,
  READONLY_TOOL_NAMES,
} from './planMode';
// 只借「将来会落成什么粒度」这一个纯函数：审批卡文案与落盘规则必须同源（批次 11-4）。
// trust.ts 只依赖 shared/protocol 与 fs/path，不引入 runtime 依赖，也不会与 server.ts 成环。
import { buildRuleForCommand } from './trust';
import { CommandSandbox } from './sandbox';

export interface RealAgentConfig {
  model: ChatModel;
  /** 高危命令策略；无论是否配置，内置高危拒绝规则（DEFAULT_DENY_PATTERNS）都会生效 */
  commandPolicy?: CommandPolicy;
  /** 命令执行器（测试注入；缺省 child_process） */
  commandRunner?: CommandRunner;
  /** 工具调用轮数上限，防止死循环 */
  maxToolRounds?: number;
  /**
   * 写入类工具的**连续**失败阈值（批次 11-2）。undefined = 用协议缺省。
   * 只数 `write_file` / `apply_patch` 的系统侧失败，见 `isCountableWriteFailure`。
   */
  maxWriteFailures?: number;
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

/** 只读工具的定义子集（计划模式的 tools 参数）。见 `planMode.ts` 的 `READONLY_TOOL_NAMES`。 */
const READONLY_TOOL_DEFINITIONS: ToolDefinition[] = TOOL_DEFINITIONS.filter((t) =>
  READONLY_TOOL_NAMES.includes(t.name)
);

/** 计划阶段的结局。`ok:false` 时调用方据此收尾（已自行播报原因的不重复播报）。 */
type PlanPhaseOutcome =
  | { ok: true; plan: string }
  | { ok: false; reason: 'canceled' | 'error' | 'empty' };

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
  const trajectory = (kind: string, detail: string, meta?: TrajectoryMeta) =>
    ctx.notify(EVENTS.Trajectory, {
      sessionId: ctx.sessionId,
      // 步号优先取**会话**计数（会话内单调递增）；只有裸 context 才回落到进程内兜底
      step: ctx.nextStep?.() ?? ++fallbackStepCounter,
      kind,
      detail,
      ts: Date.now(),
      // P2-8：结构化字段（tool / ok / durationMs / errorKind / tokens）随记录一起下发；
      // undefined 字段在 JSON 序列化时消失，因此不带 meta 的调用点行为与之前完全一致。
      ...meta,
    });

  /**
   * P2-8：把一轮模型调用的 token 用量记入轨迹，供"单会话成本"聚合。
   *
   * 用量是**本地估算**（`estimateTokens` 的宽字符启发式）：网关并未声明 usage，
   * 拿真实计数要解析各家流式响应里格式不同的 usage 字段（OpenAI 需 `stream_options.include_usage`，
   * Anthropic 在 message_start/message_delta 里）。因此 `estimated` 恒为 true ——
   * 消费方据此知道这是**量级参考、不是账单**，不会拿它去对账。
   */
  const recordModelUsage = (
    sent: ChatMessage[],
    out: { content?: string; reasoning?: string }
  ): void => {
    const prompt = estimateMessageTokens(sent);
    const completion = estimateTokens(out.content ?? '') + estimateTokens(out.reasoning ?? '');
    trajectory('system', `model 调用（约 ${prompt + completion} token）`, {
      tokens: { prompt, completion, total: prompt + completion, estimated: true },
    });
  };

  // 图片附件的**最后一道**校验。daemon 是安全边界，不采信"上游已经校验过" —— 协议允许
  // 任意客户端接入（examples/python-daemon 就是活证据），凡是要发给模型的内容必须在真正
  // 使用它的那一刻再验一次。不合规就**整条消息明确拒绝**，不静默丢掉那一张：这类消息里的
  // 图片往往就是提问本身，少发一张会让模型对着不存在的图作答、用户拿到一段看似正常的胡话。
  const imageCheck = sanitizeImageAttachments(attachments.filter((a) => a.kind === 'image'));
  if (!imageCheck.ok) {
    ctx.notify(EVENTS.Error, {
      sessionId: ctx.sessionId,
      code: ERROR_CODES.InvalidParams,
      message: `图片附件被拒绝：${imageCheck.reason}`,
    });
    ctx.notify(EVENTS.MessageDelta, { sessionId: ctx.sessionId, delta: `\n\n> ⚠️ ${imageCheck.reason}\n\n` });
    ctx.notify(EVENTS.SessionEnded, { sessionId: ctx.sessionId, reason: 'error' });
    trajectory('system', `session 结束：error（图片附件被拒：${imageCheck.reason}）`);
    unsubscribeCancel?.();
    return;
  }
  // 用校验后的图片替换原附件（体积换成实测值、非法字段被剔除），非图片附件保持原样与原顺序
  const safeImages = [...imageCheck.images];
  const safeAttachments: Attachment[] = attachments.map((a) =>
    a.kind === 'image' ? (safeImages.shift() as Attachment) : a
  );

  const title = ctx.isCanceled() ? prompt.slice(0, TITLE_MAX) : await generateTitle(config.model, prompt);
  ctx.notify(EVENTS.SessionStarted, { sessionId: ctx.sessionId, title });
  trajectory('system', `session 开始（real agent）：${prompt.slice(0, 80)}`);

  const messages: ChatMessage[] = buildMessages(prompt, safeAttachments);
  const maxContextTokens = config.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;
  // 批次 11-2：写入类工具连续失败阈值。钳到 >=1 —— 配成 0 或负数等于"第一次失败前就停"，
  // 那不是用户想要的语义（想要"一次都不许失败"应该配 1）。
  const maxWriteFailures = Math.max(1, config.maxWriteFailures ?? DEFAULT_MAX_WRITE_FAILURES);

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
   * 写入类工具连续失败达阈值时的收尾文案（批次 11-2）。
   *
   * 纪律与既有失败文案一致：**不报"已完成"、不猜原因**。只说三件事 ——
   * 哪一类失败、已达阈值、没有继续尝试；再给两条具体出路。
   * 「连续」二字必须出现：阈值是连续口径，写成"失败 N 次"会让用户以为在数总数。
   */
  const writeFailureNotice = (streak: number) =>
    `\n\n> ⚠️ 写入类工具连续失败 ${streak} 次（阈值 ${maxWriteFailures}），已停止继续尝试修改文件。\n` +
    '> 每次失败的具体原因见上方对应的工具行。\n' +
    '> 你可以确认文件路径与原文后再发一条消息，或在设置里调整 `dsh.agent.maxWriteFailures`。\n\n';

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
      recordModelUsage(messages, result); // P2-8：收束请求同样计入成本
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

  /**
   * P2-7 计划阶段：只调研、不改动，产出一份计划交给用户批准。
   *
   * 三条硬约束：
   *  ① **只提供只读工具** —— "批准前什么都不改"是计划模式的全部承诺，靠提示词约束不可靠，
   *     必须在工具清单这一层就拿掉 write_file / apply_patch / bash_execute；
   *  ② 调研预算与执行预算**分开计数**（`DEFAULT_PLAN_MAX_ROUNDS`）—— 共用一份的话，
   *     计划阶段读得越多、批准后可用的轮次越少，用户看到的是"批准完直接没轮次了"；
   *  ③ 系统提示词换成计划版，但**保留调研得到的工具结果** —— 执行阶段直接复用，
   *     既省一轮往返，也让"计划里写的路径"和"执行时读到的内容"是同一份。
   *
   * 跑满调研预算时的收束方式与主循环同源：不传 tools 再问一次，而不是把"没计划"丢给用户。
   */
  async function runPlanPhase(): Promise<PlanPhaseOutcome> {
    const originalSystem = messages[0];
    messages[0] = { role: 'system', content: `${SYSTEM_PROMPT}\n\n${PLAN_SYSTEM_APPENDIX}` };
    let plan = '';
    let failure: PlanPhaseOutcome | null = null;
    try {
      for (let round = 0; round < DEFAULT_PLAN_MAX_ROUNDS; round++) {
        if (ctx.isCanceled() || abort.signal.aborted) {
          failure = { ok: false, reason: 'canceled' };
          break;
        }
        fenceFilter = createToolCallFenceFilter();
        let content = '';
        let nativeToolCalls: ToolCall[] | undefined;
        let failed: Error | null = null;
        try {
          const trimmed = applyTokenBudget(messages, maxContextTokens);
          if (trimmed.length < messages.length) {
            // 与主循环同一条迹线纪律：裁掉了什么要留痕（计划阶段原本缺这一条，批次 11-1 补上）
            trajectory(
              'system',
              `上下文裁剪（计划阶段）：${messages.length} → ${trimmed.length} 条消息（预算 ${maxContextTokens} token）`
            );
            messages.length = 0;
            messages.push(...trimmed);
          }
          const result = await config.model.chat(messages, {
            signal: abort.signal,
            idleTimeoutMs: config.idleTimeoutMs,
            temperature: config.temperature,
            maxTokens: config.maxTokens,
            tools: READONLY_TOOL_DEFINITIONS,
            onChunk: streamChunk,
          });
          content = result.content;
          nativeToolCalls = result.toolCalls;
          recordModelUsage(messages, result); // P2-8：计划阶段调研的 token 也计入
        } catch (err) {
          failed = err instanceof Error ? err : new Error(String(err));
        }
        flushVisibleText();
        if (ctx.isCanceled() || abort.signal.aborted) {
          failure = { ok: false, reason: 'canceled' };
          break;
        }
        if (failed) {
          console.error(
            `[dsh-daemon] 计划阶段模型调用失败（session=${ctx.sessionId}）：${failed.message}`
          );
          ctx.notify(EVENTS.Error, {
            sessionId: ctx.sessionId,
            code: ERROR_CODES.InternalError,
            message: `计划阶段模型调用失败：${failed.message}`,
          });
          ctx.notify(EVENTS.MessageDelta, { sessionId: ctx.sessionId, delta: '\n\n[计划阶段已中止]' });
          failure = { ok: false, reason: 'error' };
          break;
        }
        ctx.notify(EVENTS.MessageDone, { sessionId: ctx.sessionId });

        const calls = nativeToolCalls && nativeToolCalls.length > 0 ? nativeToolCalls : parseToolCalls(content);
        if (calls.length === 0) {
          plan = content.trim(); // 不再调工具 => 计划已流式输出完毕
          break;
        }
        messages.push({ role: 'assistant', content, toolCalls: nativeToolCalls });
        for (const call of calls) {
          if (ctx.isCanceled()) break;
          const toolOutput = await dispatchTool(ctx, call, caps, config, trajectory);
          // 计划阶段只有只读工具，不参与写入失败计数（批次 11-2 只数 write_file / apply_patch）
          messages.push({ role: 'tool', content: `tool=${call.tool}\n${toolOutput.text}`, toolCallId: call.id });
        }
      }

      if (!failure && !plan) {
        // 调研预算用尽仍在调工具：收束成一次不带工具定义的请求，逼模型把已知信息写成计划。
        trajectory(
          'system',
          `计划阶段调研轮次已达上限（${DEFAULT_PLAN_MAX_ROUNDS} 轮），转为直接产出计划`
        );
        messages.push({ role: 'user', content: PLAN_COLLAPSE_INSTRUCTION });
        fenceFilter = null; // 不提供工具时，正文里的围栏是内容而非调用（与 requestFinalAnswer 同理）
        try {
          const r = await config.model.chat(messages, {
            signal: abort.signal,
            idleTimeoutMs: config.idleTimeoutMs,
            temperature: config.temperature,
            maxTokens: config.maxTokens,
            onChunk: streamChunk,
          });
          if (ctx.isCanceled() || abort.signal.aborted) failure = { ok: false, reason: 'canceled' };
          else {
            recordModelUsage(messages, r); // P2-8：计划收束请求
            ctx.notify(EVENTS.MessageDone, { sessionId: ctx.sessionId });
            plan = (r.content ?? '').trim();
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[dsh-daemon] 计划收束失败（session=${ctx.sessionId}）：${msg}`);
          ctx.notify(EVENTS.Error, {
            sessionId: ctx.sessionId,
            code: ERROR_CODES.InternalError,
            message: `计划收束失败：${msg}`,
          });
          failure = { ok: false, reason: 'error' };
        }
      }
    } finally {
      // 换回完整系统提示词：执行阶段仍受全部规则约束（调研结果**保留**在上下文里）。
      // 裁剪明示要一并带走：调研期间若裁过，这里直接覆盖 originalSystem 会让「上下文已被裁过」
      // 静默消失 —— 而被裁掉的内容并不会因此回来，执行阶段的模型会以为自己看到的是全部。
      if (originalSystem) messages[0] = carryTrimNotice(originalSystem, messages[0]);
    }

    if (failure) return failure;
    return plan ? { ok: true, plan } : { ok: false, reason: 'empty' };
  }

  // ---- P2-7：计划模式先跑调研 + 计划阶段，批准后才进入主循环 --------------------
  if (params.planMode) {
    const outcome = await runPlanPhase();
    if (!outcome.ok) {
      unsubscribeCancel?.();
      if (outcome.reason === 'canceled') {
        ctx.notify(EVENTS.MessageDelta, { sessionId: ctx.sessionId, delta: '\n\n[已取消]' });
        ctx.notify(EVENTS.SessionEnded, { sessionId: ctx.sessionId, reason: 'canceled' });
        trajectory('system', 'session 结束：canceled（计划阶段被取消）');
      } else if (outcome.reason === 'empty') {
        // 明说"没产出计划"而不是静默收场：用户据此才知道该补什么信息、或关掉计划开关
        ctx.notify(EVENTS.MessageDelta, {
          sessionId: ctx.sessionId,
          delta:
            '\n\n> ⚠️ 计划阶段未能产出计划（模型没有给出可用内容）。' +
            '可以再发一条更具体的消息（把目标或要看的文件说清楚），或关掉输入框的「计划」开关直接执行。\n\n',
        });
        ctx.notify(EVENTS.SessionEnded, { sessionId: ctx.sessionId, reason: 'error' });
        trajectory('system', 'session 结束：error（计划阶段未产出计划）');
      } else {
        // 失败原因已由计划阶段内的 error 事件给出，这里只收尾（不重复转述、更不猜配置）
        ctx.notify(EVENTS.SessionEnded, { sessionId: ctx.sessionId, reason: 'error' });
        trajectory('system', 'session 结束：error（计划阶段失败）');
      }
      return;
    }

    const planId = `plan_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const planPayload: EventPlanRequest = { sessionId: ctx.sessionId, planId, plan: outcome.plan };
    ctx.notify(EVENTS.PlanRequest, planPayload);
    trajectory('plan', `plan.request ${planId}`);

    const approved = await ctx.waitForUser('plan', planPayload);
    trajectory('plan', `plan.respond ${approved ? 'approved' : 'rejected'}`, {
      // P2-8：计划被拒与审批被拒同属"用户说 no"，用同一个分类聚合（但这里没有 tool 维度）
      ok: approved,
      errorKind: approved ? undefined : 'approval-denied',
    });

    if (!approved) {
      // 用户不同意这份计划 => 未做任何改动就收尾。用 canceled 而不是 completed：
      // 「已取消」才是用户此刻看到的事实，报"已完成"会让他以为改动已经发生了。
      ctx.notify(EVENTS.MessageDelta, {
        sessionId: ctx.sessionId,
        delta: '\n\n[计划未批准] 已按你的决定停止，**没有改动任何文件**。',
      });
      ctx.notify(EVENTS.SessionEnded, { sessionId: ctx.sessionId, reason: 'canceled' });
      trajectory('system', 'session 结束：canceled（计划未获批准）');
      return;
    }

    // 批准：计划与补充意见一起回灌，主循环据此执行（工具集恢复为完整清单）。
    // pinned：这两条是**用户的授权事实**，上下文裁剪必须跳过（批次 11-1）—— 计划模式的调研
    // 本身就占满预算，执行几轮后它们会漂到数组头部成为最先被丢的东西，模型随即"忘记"批准内容。
    messages.push({ role: 'assistant', content: `【已批准的计划】\n${outcome.plan}`, pinned: true });
    messages.push({ role: 'user', content: planApprovedInstruction(ctx.getPlanNote?.()), pinned: true });
    trajectory('system', '计划已获批准，进入执行阶段');
  }

  /** 模型是否自己收的尾（不再调用工具 => 已有最终回答）。false 即轮次被耗尽。 */
  let concludedByModel = false;

  /**
   * 写入类工具的**连续**失败次数（批次 11-2）。
   *
   * 语义是连续而非累计，理由是两种口径对应两种事实：
   *  · 累计失败说明"这个环境一直不行"，但模型换写法后可能已经找到对的路；
   *  · 连续失败说明"每一次尝试都在撞同一堵墙"，正是需要停机的那种。
   * 一次写入成功即清零 —— 环境已证明可用，不该再被历史失败累加惩罚。
   */
  let writeFailureStreak = 0;
  /** 是否因写入类连续失败而停机。停机路径要**跳过** requestFinalAnswer（详见下方 break 处）。 */
  let haltedByWriteFailures = false;

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
      recordModelUsage(messages, result); // P2-8：主循环每轮的 token 用量
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
      const outcome = await dispatchTool(ctx, call, caps, config, trajectory);
      messages.push({ role: 'tool', content: `tool=${call.tool}\n${outcome.text}`, toolCallId: call.id });
      // 批次 11-2：写入类成功清零，写入类系统侧失败 +1。
      // 其余（用户拒绝 / 策略拒绝 / 工具禁用 / 只读 / bash）一律不动计数 —— 理由见
      // `isCountableWriteFailure` 的三道过滤。
      if (WRITE_TOOLS.has(call.tool) && outcome.ok) writeFailureStreak = 0;
      else if (isCountableWriteFailure(call.tool, outcome)) writeFailureStreak++;
    }
    // 达阈值即停：跳出轮次循环，并且**不走** requestFinalAnswer ——
    // 那一步同样要发一次模型请求，而这里的语义就是"不再问了"。
    if (writeFailureStreak >= maxWriteFailures) {
      haltedByWriteFailures = true;
      break;
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

  // 批次 11-2：写入类连续失败达阈值 —— 直接收尾，不再向模型发任何请求。
  if (haltedByWriteFailures) {
    unsubscribeCancel?.();
    ctx.notify(EVENTS.MessageDelta, {
      sessionId: ctx.sessionId,
      delta: writeFailureNotice(writeFailureStreak),
    });
    // reason=error 而非 canceled：用户没取消，是系统主动放弃继续尝试。
    // 更不能报 completed —— 那会让"一次没改成的会话"看起来像成功了。
    ctx.notify(EVENTS.SessionEnded, { sessionId: ctx.sessionId, reason: 'error' });
    trajectory(
      'system',
      `session 结束：error（写入类工具连续失败 ${writeFailureStreak} 次，达阈值 ${maxWriteFailures}）`
    );
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

/**
 * `dispatchTool` 的结构化结果（批次 11-2）。
 *
 * 此前它返回 `Promise<string>`：成功与失败都只是一段文本，调用方想知道"这次到底成没成"
 * 只能去解析返回文案（`"写入失败："`、`"… 失败："`…）—— 那是脆的，改一句文案就静默失准。
 * 而这些判定**本来就在**往迹线写（P2-8 的 `{ok, errorKind}`），返回值把同一份事实带出来即可。
 */
interface ToolOutcome {
  /** 回灌给模型的文本（即原返回值） */
  text: string;
  ok: boolean;
  errorKind?: TrajectoryErrorKind;
}

/** 会改动工作区文件的那两个工具。 */
const WRITE_TOOLS = new Set(['write_file', 'apply_patch']);

/**
 * 这一次工具结果是否计入「写入类连续失败」计数（批次 11-2）。
 *
 * 三道过滤缺一不可：
 *  ① **只认写入类**。`bash_execute` 的非零退出是正常信息 —— `grep` 无匹配返 1、
 *     `tsc --noEmit` 有类型错误返 2、`git diff --exit-code` 有差异返 1。算进来就等于
 *     "正常的提问方式用三次就停机"。
 *  ② **只认系统侧失败**（`write-failed`）。`approval-denied` / `policy-denied` /
 *     `tool-disabled` 是**人的决定或既定策略**，把它们当成"系统坏了"会得出荒谬结论：
 *     用户连点三次拒绝 → 系统判定自身故障 → 停机。
 *  ③ 只读工具的失败一律不计：幂等、无副作用，加进计数只是噪声。
 */
function isCountableWriteFailure(tool: string, outcome: ToolOutcome): boolean {
  return WRITE_TOOLS.has(tool) && !outcome.ok && outcome.errorKind === 'write-failed';
}

function toolAllowed(caps: AgentCapabilities, name: string): boolean {
  const tools = caps.allowedTools;
  return !tools || tools.length === 0 || tools.includes(name);
}

async function dispatchTool(
  ctx: AgentContext,
  call: ToolCall,
  caps: AgentCapabilities,
  config: RealAgentConfig,
  trajectory: (kind: string, detail: string, meta?: TrajectoryMeta) => void
): Promise<ToolOutcome> {
  const { tool, input } = call;
  const sessionId = ctx.sessionId;
  const allowedDirs = caps.allowedDirs ?? [];
  const start = Date.now();

  // ---- 只读：read_file / list_dir / grep / glob
  if (tool === 'read_file' || tool === 'list_dir' || tool === 'grep' || tool === 'glob') {
    if (!toolAllowed(caps, tool)) {
      // P2-8：把"工具被禁用"作为**可分类的失败**记入轨迹，否则统计工具失败率时会漏掉这一类
      trajectory('tool', `${tool} 被禁用`, { tool, ok: false, durationMs: 0, errorKind: 'tool-disabled' });
      return { text: disabledTool(ctx, sessionId, caps, tool), ok: false, errorKind: 'tool-disabled' };
    }
    ctx.notify(EVENTS.ToolStarted, { sessionId, tool, input });
    trajectory('tool', `${tool} ${JSON.stringify(input)}`, { tool });
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
      trajectory('tool', `${tool} 完成`, { tool, ok: true, durationMs: Date.now() - start });
      return { text: output, ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ctx.notify(EVENTS.ToolExecuted, { sessionId, tool, ok: false, output: msg, durationMs: Date.now() - start });
      trajectory('tool', `${tool} 失败：${msg}`, {
        tool,
        ok: false,
        durationMs: Date.now() - start,
        errorKind: 'exec-failed',
      });
      // 只读工具的失败**不进**写入失败计数：幂等、无副作用，计入只是噪声（见 isCountableWriteFailure）
      return { text: `${tool} 失败：${msg}`, ok: false, errorKind: 'exec-failed' };
    }
  }

  // ---- 修改：write_file / apply_patch（经 Diff 审查）
  if (tool === 'write_file' || tool === 'apply_patch') {
    if (!toolAllowed(caps, tool)) {
      // P2-8：把"工具被禁用"作为**可分类的失败**记入轨迹，否则统计工具失败率时会漏掉这一类
      trajectory('tool', `${tool} 被禁用`, { tool, ok: false, durationMs: 0, errorKind: 'tool-disabled' });
      return { text: disabledTool(ctx, sessionId, caps, tool), ok: false, errorKind: 'tool-disabled' };
    }
    // 批次 11-2 修正 A：写入分支此前**既没有** tool.started / tool.executed，**也没有** 带
    // ok/errorKind 的工具迹线 —— 结果是写入类工具的真失败在面板与迹线里双双不可见，只剩一行
    // error 事件。这里补到与只读分支对等；否则计数虽能靠返回值算出来，却与迹线对不上，
    // "迹线里能看到失败类别与计数"这条验收无法成立。
    ctx.notify(EVENTS.ToolStarted, { sessionId, tool, input });
    trajectory('tool', `${tool} ${JSON.stringify(input)}`, { tool });
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
      trajectory('patch', `file.patch.pending ${resolved}`, { tool, durationMs: Date.now() - start });

      const accepted = await ctx.waitForUser('patch', patchPayload);
      trajectory('patch', `file.patch.respond ${accepted ? 'accept' : 'reject'}`, {
        tool,
        ok: accepted,
        durationMs: Date.now() - start,
        errorKind: accepted ? undefined : 'approval-denied',
      });

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

      if (!accepted) {
        // 用户拒绝写入：**不算系统故障**（isCountableWriteFailure 的第 ② 条）。
        // 把它计进"连续失败"会得出荒谬结论：用户连点三次拒绝 → 系统判定自身故障 → 停机。
        const rejected = `用户拒绝了修改 ${resolved}`;
        ctx.notify(EVENTS.ToolExecuted, {
          sessionId,
          tool,
          ok: false,
          output: rejected,
          durationMs: Date.now() - start,
        });
        trajectory('tool', `${tool} 用户拒绝`, {
          tool,
          ok: false,
          durationMs: Date.now() - start,
          errorKind: 'approval-denied',
        });
        return { text: rejected, ok: false, errorKind: 'approval-denied' };
      }

      // 两条通路都算成功：真落盘（applied）与"已应用到编辑器未保存缓冲区"（appliedInEditor）——
      // 后者改动确实发生了，只是等用户保存，不该记成失败。
      const written = result.applied || result.appliedInEditor;
      const outcomeText = describePatchOutcome(result, resolved);
      ctx.notify(EVENTS.ToolExecuted, {
        sessionId,
        tool,
        ok: written,
        output: outcomeText,
        durationMs: Date.now() - start,
      });
      if (written) {
        trajectory('tool', `${tool} 完成`, { tool, ok: true, durationMs: Date.now() - start });
        return { text: outcomeText, ok: true };
      }
      // 应用失败（乐观锁冲突 / 脏文档保护跳过 / IO）—— 系统侧失败，计入连续失败
      trajectory('tool', outcomeText, {
        tool,
        ok: false,
        durationMs: Date.now() - start,
        errorKind: 'write-failed',
      });
      return { text: outcomeText, ok: false, errorKind: 'write-failed' };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ctx.notify(EVENTS.Error, { sessionId, code: (e as { code?: number }).code, message: msg });
      // catch 覆盖的是路径越界 / apply_patch 的 search 未命中 / 原文件读不到 ——
      // 都属系统侧失败（模型可以换个写法修好，但连续撞同一堵墙就该停）。
      ctx.notify(EVENTS.ToolExecuted, {
        sessionId,
        tool,
        ok: false,
        output: msg,
        durationMs: Date.now() - start,
      });
      trajectory('tool', `${tool} 失败：${msg}`, {
        tool,
        ok: false,
        durationMs: Date.now() - start,
        errorKind: 'write-failed',
      });
      return { text: `${tool} 失败：${msg}`, ok: false, errorKind: 'write-failed' };
    }
  }

  // ---- 高危命令：bash_execute（审批 + 策略门控）
  if (tool === 'bash_execute' || tool === 'bash' || tool === 'run_command') {
    if (!toolAllowed(caps, 'bash_execute')) {
      trajectory('tool', 'bash_execute 被禁用', {
        tool: 'bash_execute',
        ok: false,
        durationMs: 0,
        errorKind: 'tool-disabled',
      });
      return { text: disabledTool(ctx, sessionId, caps, 'bash_execute'), ok: false, errorKind: 'tool-disabled' };
    }
    const command = String(input.command ?? '');
    ctx.notify(EVENTS.ToolStarted, { sessionId, tool: 'bash_execute', input });
    trajectory('tool', `bash_execute ${JSON.stringify(input)}`, { tool: 'bash_execute' });

    const decision = evaluateCommandPolicy(command, config.commandPolicy ?? {});
    if (!decision.allowed) {
      ctx.notify(EVENTS.ToolExecuted, {
        sessionId,
        tool: 'bash_execute',
        ok: false,
        output: `命令被策略拒绝：${decision.reason}`,
        durationMs: Date.now() - start,
      });
      trajectory('tool', `bash_execute 策略拒绝：${decision.reason}`, {
        tool: 'bash_execute',
        ok: false,
        durationMs: Date.now() - start,
        errorKind: 'policy-denied',
      });
      return { text: `命令被策略拒绝：${decision.reason}`, ok: false, errorKind: 'policy-denied' };
    }

    // P2-9：风险等级按命令内容分级（删除/破坏 = high；写/网络 = medium；只读 = low）。
    // 分级只影响 UI 呈现强度，**不改变"仍要审批"这一事实** —— 免审批只由信任白名单决定。
    const commandRisk = classifyCommandRisk(command);
    const approvalId = `approval_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const approvalParams: EventApprovalRequest = {
      sessionId,
      approvalId,
      tool: 'bash_execute',
      input: { command },
      risk: commandRisk,
      reason: riskReason(commandRisk, command),
      // 批次 11-4：告诉 UI「记住」到底记住什么。取的是**用户真点下去之后会落盘的那条规则**
      // （server.ts 的 approval.respond 走 TrustStore.add → 同一个 buildRuleForCommand），
      // 所以按钮文案与实际行为同源，不会出现"写着同类不再问、实际只记住一条"。
      trustKind: buildRuleForCommand(command, Date.now()).kind,
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
      trajectory('tool', `bash_execute 命中信任规则，免审批（${run.ok ? 'ok' : '失败'}）`, {
        tool: 'bash_execute',
        ok: run.ok,
        durationMs: run.durationMs,
        errorKind: run.ok ? undefined : 'exec-failed',
      });
      // bash 的成败**不进**写入失败计数（非零退出是正常信息，见 isCountableWriteFailure）
      return { text: run.output, ok: run.ok, errorKind: run.ok ? undefined : 'exec-failed' };
    }
    ctx.notify(EVENTS.ApprovalRequest, approvalParams);
    trajectory('approval', 'approval.request bash_execute', { tool: 'bash_execute' });

    const approved = await ctx.waitForUser('approval', approvalParams);
    trajectory('approval', `approval.respond ${approved ? 'approved' : 'rejected'}`, {
      tool: 'bash_execute',
      ok: approved,
      durationMs: Date.now() - start,
      errorKind: approved ? undefined : 'approval-denied',
    });
    if (!approved) {
      ctx.notify(EVENTS.ToolExecuted, {
        sessionId,
        tool: 'bash_execute',
        ok: false,
        output: '已取消：用户拒绝了该命令。',
        durationMs: Date.now() - start,
      });
      return { text: '已取消：用户拒绝了该命令。', ok: false, errorKind: 'approval-denied' };
    }

    const run = await executeCommand(command, ctx.workspaceRoot, { timeoutMs: 30_000, runner: config.commandRunner, sandbox: config.sandbox });
    ctx.notify(EVENTS.ToolExecuted, { sessionId, tool: 'bash_execute', ok: run.ok, output: run.output, durationMs: run.durationMs });
    trajectory('tool', 'bash_execute 完成', {
      tool: 'bash_execute',
      ok: run.ok,
      durationMs: run.durationMs,
      errorKind: run.ok ? undefined : 'exec-failed',
    });
    return { text: run.output, ok: run.ok, errorKind: run.ok ? undefined : 'exec-failed' };
  }

  // 未知工具
  ctx.notify(EVENTS.ToolExecuted, {
    sessionId,
    tool,
    ok: false,
    output: `未知工具：${tool}`,
    durationMs: 0,
  });
  return { text: `未知工具：${tool}`, ok: false, errorKind: 'internal' };
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
  const images: ChatContentPart[] = [];
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
      case 'image':
        // 图片不能折进文本里（base64 塞进 <file> 只会变成噪声）。它以独立内容块参与请求，
        // 文本侧只留一行**位置标记**：多张图时模型据此知道"第 2 张"指的是哪一张。
        if (a.mimeType && a.dataBase64) {
          images.push({ type: 'image', mimeType: a.mimeType, dataBase64: a.dataBase64 });
          parts.push(`\n[图片 ${images.length}${a.name ? `：${a.name}` : ''}]`);
        }
        break;
    }
  }
  const text = parts.join('\n');
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      // 没有图片时**保持纯字符串**：改造前后请求体逐字节一致（"加一个能力"不该
      // 动到不使用它的请求）。有图片才升格为内容块数组。
      content: images.length > 0 ? [{ type: 'text' as const, text }, ...images] : text,
    },
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

/**
 * 单张图片的 token 估算（保守常量）。
 *
 * 精确值要按像素算（Anthropic 约 `宽 × 高 / 750`），而 daemon 手里只有 base64 ——
 * 要拿尺寸就得解 PNG/JPEG 头，为一次估算引入半个图片解析器不划算。
 * 前端已把长边压到 1568px 以内（最坏约 3.3k），这里取 2048 作为典型截图
 * （约 1500×800 ≈ 1.6k）偏保守的估计。
 * 偏向保守是有理由的：**估松了**请求会被服务端以超长拒绝（用户看到的是"模型报错"），
 * **估紧了**只是多裁掉一轮旧工具结果 —— 后者的代价小得多，而且方向可预期。
 */
export const IMAGE_TOKEN_ESTIMATE = 2048;

function estimateMessageTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') {
      total += estimateTokens(m.content);
    } else {
      for (const p of m.content) {
        total += p.type === 'text' ? estimateTokens(p.text) : IMAGE_TOKEN_ESTIMATE;
      }
    }
    if (m.toolCalls) total += estimateTokens(JSON.stringify(m.toolCalls));
  }
  return total;
}

/**
 * 裁剪明示（批次 11-1）：裁剪一旦真的发生，就把它**折进 `messages[0]` 的 system 内容**。
 *
 * 为什么不另插一条 system 消息：
 *  - `toAnthropicMessages`（`model.ts`）会把数组里**所有** system 消息上提到顶层 `system`
 *    字段并跳过 —— 插在中间等于丢掉位置信息；
 *  - 更要紧的是插在索引 2 会打破下面 `applyTokenBudget` 自己的结构不变量
 *    （`[0]=system,[1]=user,[2]=assistant`），下一次调用会直接静默不裁剪。
 *  追加一行则索引一个都不动，两家 provider 都天然生效。
 *
 * 前缀同时是**幂等标记**：写入前先按它剥掉上一次的明示，于是整场会话永远只有一条，
 * 不会随轮次越积越多。文案刻意不给条数 —— 累计值得额外状态，而"本轮条数"会被读成总量；
 * 精确数字仍走执行迹线。
 */
export const CONTEXT_TRIM_NOTICE_PREFIX = '【上下文裁剪】';

const CONTEXT_TRIM_NOTICE =
  `${CONTEXT_TRIM_NOTICE_PREFIX}更早的对话已按上下文预算移除；如需早前细节，请重新读取文件或让用户补充。`;

function hasTrimNotice(msg: ChatMessage): boolean {
  return contentToText(msg.content)
    .split('\n')
    .some((line) => line.startsWith(CONTEXT_TRIM_NOTICE_PREFIX));
}

/** 把裁剪明示挂到 system 消息上（返回**新对象**，不污染调用方持有的那条）。 */
function withTrimNotice(system: ChatMessage): ChatMessage {
  const kept = contentToText(system.content)
    .split('\n')
    .filter((line) => !line.startsWith(CONTEXT_TRIM_NOTICE_PREFIX));
  return { ...system, content: [...kept, CONTEXT_TRIM_NOTICE].join('\n') };
}

/**
 * 把 `from` 上的裁剪明示搬到 `base` 上 —— 计划阶段结束时会把 `messages[0]` 换回完整提示词，
 * 若调研期间裁过，明示必须跟着走，否则"上下文被裁过"这件事会在执行阶段静默消失。
 * `from` 没有明示就原样返回 `base`（同一引用，零开销）。
 */
function carryTrimNotice(base: ChatMessage, from: ChatMessage): ChatMessage {
  return hasTrimNotice(from) ? withTrimNotice(base) : base;
}

/**
 * 丢最旧的**可裁单元**（assistant + 紧随的 tool 结果）直到回到预算内；`pinned` 的一律跳过。
 *
 * 返回值是**停机收口**：一个可裁单元都没有时（例如剩下的全是 pinned）返回 false，
 * 调用方据此知道"超预算但裁不动"，不会空转 —— 写成 `while + splice` 而漏了这个出口就是死循环。
 * tool 结果必须跟着它的 assistant 一起走，否则原生 toolCalls/toolCallId 配对会被拆散。
 */
function dropOldestUnits(s: ChatMessage[], maxTokens: number): boolean {
  let dropped = false;
  while (s.length > 2 && estimateMessageTokens(s) > maxTokens) {
    let start = 2;
    while (start < s.length && s[start].pinned) start++;
    if (start >= s.length) break; // 剩下的全是不可裁单元：停
    let end = start + 1;
    while (end < s.length && s[end].role === 'tool') end++;
    s.splice(start, end - start);
    dropped = true;
  }
  return dropped;
}

/**
 * 上下文预算裁剪：超出 maxTokens 时从最旧的工具轮次（assistant + 紧随的 tool 结果）
 * 整轮向前丢弃，保留 system + 初始 user + 最近轮次；整轮裁剪不拆散原生 toolCalls/toolCallId 配对。
 *
 * 批次 11-1 追加两条纪律：
 *  - `pinned` 单元（用户已批准的计划与批准时的补充意见）**永不裁剪**；
 *  - 真裁了东西才挂裁剪明示，并**再收一轮**（明示自己也占 token，否则会"越裁越长"）；
 *    没裁动就原样返回，保住"未变即同一引用"的既有语义。
 */
export function applyTokenBudget(messages: ChatMessage[], maxTokens: number): ChatMessage[] {
  if (estimateMessageTokens(messages) <= maxTokens || messages.length <= 2) return messages;
  // 不变量：[0]=system，[1]=user(初始)，[2]=assistant（首轮，其后为 tool* 轮次序列）；非此结构不裁剪（防御外部误用）
  if (messages[0].role !== 'system' || messages[1].role !== 'user' || messages[2]?.role !== 'assistant') return messages;
  const copy = messages.slice();
  if (!dropOldestUnits(copy, maxTokens)) return messages;
  copy[0] = withTrimNotice(copy[0]);
  dropOldestUnits(copy, maxTokens);
  return copy;
}
