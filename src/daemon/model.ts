/**
 * 模型适配层（P3.1）。
 *
 * 定义统一 ChatModel 接口，提供：
 *  - OpenAICompatibleModel：OpenAI 兼容的流式实现（DeepSeek / OpenAI 等），
 *    同时区分 reasoning_content（思维链）与 content（正文），供真实 daemon
 *    分别投影为 reasoning.delta 与 message.delta。
 *  - FakeChatModel：可编程/脚本化的假模型，用于单元测试与集成冒烟
 *    （不起网络、确定性输出）。
 *
 * 真实 daemon 通过 ChatModel 接口调用模型，替换底座不影响 Agent 循环。
 */

import { DEFAULT_MAX_OUTPUT_TOKENS, DEFAULT_TEMPERATURE } from '../../shared/protocol';
import { isPlanPhase } from './planMode';
import { ToolCall } from './toolcall';

/**
 * 模型请求空闲超时（P0-3）：首字节与增量之间允许的最大静默时长。
 *
 * 仅靠调用方的 `AbortSignal` 不够——若用户不取消，而模型端连着却长时间不吐字节
 * （网关挂住 / 连接半开 / 服务端排队），会话会**永久挂起**在 `running` 态，UI 只能干等。
 * 这里以「空闲计时」兜底：每收到一个增量就重置计时器，静默超过阈值即以
 * `TimeoutError` 中断请求，由 Agent 循环按模型调用失败收尾（session.ended reason=error）。
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

/**
 * 多模态消息内容块。
 *
 * `ChatMessage.content` 平时是纯文本，**只有用户附了图片的那条消息**会变成数组。
 * 这样"99% 的情况"完全不受影响（仍是字符串、请求体逐字节不变），而两家 provider 的差异
 * （OpenAI 的 `image_url` data URL / Anthropic 的 base64 `source` 块）被收敛在各自的
 * 序列化函数里 —— 与 `toolCalls` 的处理方式同源：**上层只认一种表示，provider 负责适配**。
 */
export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; dataBase64: string };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ChatContentPart[];
  /** 原生工具调用（assistant 消息）；fenced 场景不设此字段 */
  toolCalls?: ToolCall[];
  /** tool 消息对应的原生调用 id（OpenAI tool_call_id / Anthropic tool_use_id） */
  toolCallId?: string;
}

/**
 * 把消息内容取成纯文本（多模态时拼接其中的文本块，**丢弃图片**）。
 *
 * 所有"把内容当文本用"的地方（system 拼接、假模型的关键字匹配、token 估算）都走这里。
 * 单独抽成函数的价值在于：`content` 一旦变成联合类型，TypeScript 会把每一处误用都指出来，
 * 而这里是那些误用的**唯一出口** —— 谁也别再自己 `String(m.content)` 或 `m.content.includes`。
 */
export function contentToText(content: string | ChatContentPart[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is Extract<ChatContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

export type StreamChunkType = 'reasoning' | 'content';

export interface StreamChunk {
  type: StreamChunkType;
  text: string;
}

/** 工具的 JSON Schema 定义（OpenAI function / Anthropic tool）。 */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema 参数定义（OpenAI function.parameters / Anthropic input_schema） */
  parameters: Record<string, unknown>;
}

export interface ChatCompletionResult {
  /** 思维链文本（可为空） */
  reasoning: string;
  /** 回答正文（包含可能的工具调用块） */
  content: string;
  /** 原生工具调用（模型以 function calling / tool_use 发起时） */
  toolCalls?: ToolCall[];
}

export interface ChatStreamOptions {
  /** 采样温度（0–2）：OpenAI 兼容直传；Anthropic 钳制到 0–1。未设 = DEFAULT_TEMPERATURE。 */
  temperature?: number;
  /**
   * 单次输出上限（max_tokens）。未设 / `<= 0` = OpenAI 兼容端点**不发送**该字段
   * （由服务端决定上限）；Anthropic 必填，故回落 DEFAULT_MAX_OUTPUT_TOKENS。
   */
  maxTokens?: number;
  signal?: AbortSignal;
  /** 空闲超时（ms）：距上一个增量超过该时长即以 TimeoutError 中断；<= 0 关闭。缺省 60s。 */
  idleTimeoutMs?: number;
  /** 每个增量到达时回调（reasoning 与 content 分别触发） */
  onChunk?: (chunk: StreamChunk) => void;
  /** 暴露给模型的工具清单（原生 function calling） */
  tools?: ToolDefinition[];
  /** 瞬时失败自动重试次数（缺省 2，0 关闭）。仅对"尚未推送任何增量"的请求生效。 */
  maxRetries?: number;
}

export interface ChatModel {
  chat(messages: ChatMessage[], opts?: ChatStreamOptions): Promise<ChatCompletionResult>;
}

/** 瞬时失败自动重试次数（缺省）。 */
export const DEFAULT_MAX_RETRIES = 2;
/** 重试退避基数（ms）：第 n 次重试等待 baseDelay * 2^n。 */
export const RETRY_BASE_DELAY_MS = 600;

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 判定「值得重试的瞬时失败」。
 *
 * 只有两类值得重试：
 *  1. **网络层错误**（无 HTTP 状态码：DNS / TLS / 连接重置 / 代理抖动）；
 *  2. **429 与 5xx**（限流、上游异常）。
 * 其余 4xx 都是确定性错误（401 Key 无效、402 余额不足、404 模型不存在……），重试只会让用户
 * 多等两秒再读到同一句话；取消与空闲超时也不重试——取消是用户意图，超时意味着流已中断，
 * 已经推送出去的增量收不回来。
 *
 * 实测教训：真实会话里三次「模型调用失败」有两次在 ~110ms 内就返回了，而 19 秒后的同一请求
 * 却成功了——典型的瞬时失败。当时没有重试，一次网络抖动就等于整场会话"自动中断"。
 */
function isRetryableFailure(err: Error): boolean {
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return false;
  const status = (err as Error & { httpStatus?: number }).httpStatus;
  if (typeof status === 'number') return status === 429 || status >= 500;
  return true; // 无状态码 => fetch 层抛出的网络错误
}

/**
 * 给任意 ChatModel 叠加「瞬时失败自动重试」（装饰器）。
 *
 * **只在本次尝试尚未向前端推送任何增量时才重试**：一旦有 delta 到达，重试会把同一段正文
 * 再推一遍，前端出现重复内容——那比直接失败更难排查。
 * 重试次数可用 `ChatStreamOptions.maxRetries` 逐次覆盖（如标题生成这类短请求设为 0）。
 */
export interface RetryOptions {
  /** 瞬时失败自动重试次数（缺省 2）。 */
  maxRetries?: number;
  /** 退避基数（ms，缺省 600）：第 n 次重试等待 baseDelayMs * 2^n。 */
  baseDelayMs?: number;
}

export function withRetry(model: ChatModel, options: RetryOptions = {}): ChatModel {
  return {
    async chat(messages: ChatMessage[], opts: ChatStreamOptions = {}): Promise<ChatCompletionResult> {
      const maxRetries = opts.maxRetries ?? options.maxRetries ?? DEFAULT_MAX_RETRIES;
      const baseDelayMs = options.baseDelayMs ?? RETRY_BASE_DELAY_MS;
      const userOnChunk = opts.onChunk;
      let streamed = false;
      const wrapped: ChatStreamOptions = {
        ...opts,
        onChunk: (c) => {
          streamed = true;
          userOnChunk?.(c);
        },
      };
      for (let attempt = 0; ; attempt++) {
        try {
          return await model.chat(messages, wrapped);
        } catch (err) {
          const e = err instanceof Error ? err : new Error(String(err));
          const canRetry = attempt < maxRetries && !streamed && !opts.signal?.aborted && isRetryableFailure(e);
          if (!canRetry) throw e;
          const waitMs = baseDelayMs * 2 ** attempt;
          console.error(`[dsh-daemon] 模型请求失败（第 ${attempt + 1} 次），${waitMs}ms 后重试：${e.message}`);
          await sleepMs(waitMs);
        }
      }
    },
  };
}

export interface OpenAIModelOptions {
  baseURL?: string;
  apiKey: string;
  model?: string;
}

export interface AnthropicModelOptions {
  baseURL?: string;
  apiKey: string;
  model?: string;
}

const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';
// 2026/07/24 起 `deepseek-chat` / `deepseek-reasoner` 已弃用（用旧名会直接报错），
// 缺省名改为官方现行的 `deepseek-flash`（DeepSeek-V4.1-Flash）。
const DEFAULT_MODEL = 'deepseek-flash';
const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_ANTHROPIC_MODEL = 'claude-3-5-sonnet-latest';

/**
 * 以「空闲超时」包裹一次流式请求（P0-3）。
 *
 * 内部复合一个 AbortController：调用方 signal 与超时都能中断同一个 fetch。
 * 每收到一个 SSE 事件即重置计时器；静默超过 idleTimeoutMs 即 abort，
 * 并把 `fetch`/解析层抛出的 abort 错误改写为可读的 TimeoutError。
 *
 * 返回 `{ signal, onActivity, dispose }`：
 *  - `signal` 传给 `fetch`；
 *  - `onActivity()` 由 SSE 解析器在每个事件到达时调用（重置空闲计时）；
 *  - `dispose()` 在请求收尾时清理计时器与监听。
 */
function withIdleTimeout(
  external: AbortSignal | undefined,
  idleTimeoutMs: number
): { signal: AbortSignal; onActivity: () => void; dispose: () => void; timedOut: () => boolean } {
  const ctrl = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const onExternalAbort = () => ctrl.abort(external?.reason);
  if (external) {
    if (external.aborted) ctrl.abort(external.reason);
    else external.addEventListener('abort', onExternalAbort, { once: true });
  }

  const arm = () => {
    if (timer) clearTimeout(timer);
    if (idleTimeoutMs <= 0) return; // <= 0 关闭空闲超时（测试/禁用用）
    timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort(new Error(`模型响应空闲超时（${idleTimeoutMs}ms 内无任何增量）`));
    }, idleTimeoutMs);
    // 不阻止进程退出（daemon 长驻，但计时器不应成为 keep-alive 来源）
    (timer as unknown as { unref?: () => void }).unref?.();
  };
  arm();

  return {
    signal: ctrl.signal,
    onActivity: arm,
    timedOut: () => timedOut,
    dispose: () => {
      if (timer) clearTimeout(timer);
      external?.removeEventListener('abort', onExternalAbort);
    },
  };
}

/** 统一的请求失败信息：区分「空闲超时」「调用方取消」「其它网络错误」。 */
function describeFetchError(err: unknown, guard: { timedOut: () => boolean }): Error {
  if (guard.timedOut()) {
    const e = new Error('模型请求空闲超时：连接建立后长时间未收到任何增量，已中断。');
    e.name = 'TimeoutError';
    return e;
  }
  // 中断（取消）：平台可能抛 DOMException/AbortError，措辞为 "This operation was aborted"，
  // 也可能由解析层的 abortReason() 抛出，统一归一化为可读文案。
  if (isAbortLike(err)) {
    const e = new Error('模型请求已取消。');
    e.name = 'AbortError';
    return e;
  }
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * 常见 HTTP 状态 → 可执行提示。缺失的键按状态段兜底（5xx 视为上游异常）。
 */
const HTTP_STATUS_HINTS: Record<number, string> = {
  400: '请求被上游拒绝（多为消息或参数格式不被接受）',
  401: 'API Key 无效或未配置，请检查 dsh.apiKey',
  402: '上游账号余额不足，请充值后重试',
  403: '无访问权限：Key 无权访问该模型，或该模型未开通',
  404: '接口或模型不存在，请检查 dsh.model 与 dsh.baseUrl',
  413: '请求体过大，请减少上下文或附件后重试',
  422: '上游判定请求语义不合法，请确认 dsh.model 是否可用',
  429: '触发上游限流，请稍后重试',
};

/**
 * 把模型接口的 HTTP 失败翻译成"能照着做"的文案。
 *
 * 为什么不直接把响应体抛给用户：
 *  1) 上游给的是机器可读 JSON（`{"error":{"message":"Insufficient Balance",...}}`），
 *     原样透出既不解释原因、长文本还会把面板排版撑坏；
 *  2) 更要紧的是**不能诱导错误的排查方向**——曾在前端硬写"请检查 apiKey 与 model 配置"，
 *     而上游返回 402 余额不足时这句话与配置毫无关系（实测把用户带偏过）。
 *
 * 因此这里按状态码给出确定的原因与动作，并保留上游原文作为佐证。
 */
export function describeHttpError(status: number, rawBody: string): Error {
  const detail = extractUpstreamMessage(rawBody);
  const hint = HTTP_STATUS_HINTS[status] ?? (status >= 500 ? '上游服务异常，请稍后重试' : '');
  const tail = [hint, detail ? `上游返回：${detail}` : ''].filter(Boolean).join('；');
  const err = new Error(tail ? `HTTP ${status}：${tail}` : `HTTP ${status}`);
  // 带上状态码，供重试策略判定（429/5xx 可重试，其余 4xx 不可）——从错误文案里正则抠状态码太脆。
  (err as Error & { httpStatus?: number }).httpStatus = status;
  return err;
}

/**
 * 从上游错误体里掏出人话：优先 JSON 的 error.message / message，非 JSON 则按原文截断。
 * 截断是为了不让一坨原始 JSON 把 webview 的正文列撑成十几行。
 */
function extractUpstreamMessage(rawBody: string): string {
  const body = String(rawBody ?? '').trim();
  if (!body) return '';
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown }; message?: unknown };
    const msg = parsed?.error?.message ?? parsed?.message;
    if (typeof msg === 'string' && msg.trim()) return msg.trim();
  } catch {
    /* 不是 JSON，按原文处理 */
  }
  return body.length > MAX_UPSTREAM_DETAIL_LEN ? body.slice(0, MAX_UPSTREAM_DETAIL_LEN) + '…' : body;
}

const MAX_UPSTREAM_DETAIL_LEN = 120;

/** 判定是否为中断类错误（不同运行时措辞不一：AbortError / "operation was aborted"）。 */
function isAbortLike(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError') return true;
  if (err.name === 'TimeoutError') return false; // 空闲超时单独走 timedOut 分支
  return /abort/i.test(err.message);
}

/**
 * 中断后应抛出的错误：优先沿用 `signal.reason`（可携带具体原因，如空闲超时描述），
 * 否则退回一个通用 AbortError。
 */
function abortReason(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const e = new Error(reason === undefined ? '模型请求已取消。' : String(reason));
  e.name = 'AbortError';
  return e;
}

export class OpenAICompatibleModel implements ChatModel {
  private readonly baseURL: string;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(opts: OpenAIModelOptions) {
    this.baseURL = (opts.baseURL || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.model = opts.model || DEFAULT_MODEL;
  }

  async chat(messages: ChatMessage[], opts: ChatStreamOptions = {}): Promise<ChatCompletionResult> {
    const idle = withIdleTimeout(opts.signal, opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);
    try {
      let res: Response;
      try {
        res = await fetch(`${this.baseURL}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(toOpenAIBody(this.model, messages, opts)),
          signal: idle.signal,
        });
      } catch (err) {
        throw describeFetchError(err, idle);
      }

      if (!res.ok || !res.body) {
        const body = await res.text().catch(() => '');
        throw describeHttpError(res.status, body);
      }
      const userOnChunk = opts.onChunk ?? (() => {});
      try {
        return await parseSSE(
          res.body as unknown as AsyncIterable<Uint8Array>,
          (c) => {
            idle.onActivity(); // 每个增量重置空闲计时
            userOnChunk(c);
          },
          idle.signal
        );
      } catch (err) {
        // 流读取/解析阶段也可能因中断而抛（平台原生 AbortError），统一归一化
        throw describeFetchError(err, idle);
      }
    } finally {
      idle.dispose();
    }
  }
}

/**
 * Anthropic Messages API 适配（P3.5+ 多 provider）。
 *
 * 与 OpenAI 兼容端点不同：`/v1/messages`、`x-api-key` 头、`anthropic-version` 头、
 * system 为顶层字段（无 system 角色消息）、工具结果降级为 user 消息。
 * 流式 SSE 以 content_block_delta 事件区分 text_delta（正文）与 thinking_delta（思维链）。
 */
export class AnthropicModel implements ChatModel {
  private readonly baseURL: string;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(opts: AnthropicModelOptions) {
    this.baseURL = (opts.baseURL || DEFAULT_ANTHROPIC_BASE_URL).replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.model = opts.model || DEFAULT_ANTHROPIC_MODEL;
  }

  async chat(messages: ChatMessage[], opts: ChatStreamOptions = {}): Promise<ChatCompletionResult> {
    const { system, messages: anthropicMessages } = toAnthropicMessages(messages);
    const idle = withIdleTimeout(opts.signal, opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);
    try {
      let res: Response;
      try {
        res = await fetch(`${this.baseURL}/v1/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': this.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify(toAnthropicBody(this.model, opts, system, anthropicMessages)),
          signal: idle.signal,
        });
      } catch (err) {
        throw describeFetchError(err, idle);
      }

      if (!res.ok || !res.body) {
        const body = await res.text().catch(() => '');
        throw describeHttpError(res.status, body);
      }
      const userOnChunk = opts.onChunk ?? (() => {});
      try {
        return await parseAnthropicSSE(
          res.body as unknown as AsyncIterable<Uint8Array>,
          (c) => {
            idle.onActivity();
            userOnChunk(c);
          },
          idle.signal
        );
      } catch (err) {
        throw describeFetchError(err, idle);
      }
    } finally {
      idle.dispose();
    }
  }
}

/** Anthropic Messages 中一条消息 content 的块形状（text / image / tool_use / tool_result）。 */
type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

/**
 * 统一 content → Anthropic 内容块。
 *
 * 图片用 `source.type = 'base64'`（而非 url）：图片字节是本进程从用户剪贴板
 * 直接拿到的，**没有任何 URL 可指**；而且让模型端点去拉一个 URL，等于把
 * "谁在何时看到这张图"变成第三方可见的请求 —— 用户粘一张内部截图时这不可接受。
 */
function toAnthropicContent(content: string | ChatContentPart[]): AnthropicContent {
  if (typeof content === 'string') return content;
  return content.map((p) =>
    p.type === 'text'
      ? { type: 'text' as const, text: p.text }
      : {
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: p.mimeType, data: p.dataBase64 },
        }
  );
}

/** Anthropic 消息 content：纯文本或块数组。 */
type AnthropicContent = string | AnthropicContentBlock[];

/** fenced 兜底场景：无原生调用 id 的工具结果作为 user 文本回灌时的前缀。 */
const TOOL_RESULT_PREFIX = '[工具结果]\n';

/** 将统一的 ChatMessage[] 转换为 Anthropic Messages 载荷（system 置顶、原生 tool_use/tool_result、无 id 的 tool 降级为 user 文本）。 */
function toAnthropicMessages(messages: ChatMessage[]): {
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: AnthropicContent }>;
} {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => contentToText(m.content))
    .join('\n\n');
  const out: Array<{ role: 'user' | 'assistant'; content: AnthropicContent }> = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      // 原生：assistant 的 tool_use 块（正文为可选的 text 块）
      const answer = contentToText(m.content);
      out.push({
        role: 'assistant',
        content: [
          ...(answer ? [{ type: 'text' as const, text: answer }] : []),
          ...m.toolCalls.map((tc) => ({ type: 'tool_use' as const, id: tc.id ?? '', name: tc.tool, input: tc.input })),
        ],
      });
    } else if (m.role === 'tool' && m.toolCallId) {
      // 原生：tool 结果回灌为 user 的 tool_result 块（工具结果是文本，不存在图片）
      out.push({
        role: 'user',
        content: [{ type: 'tool_result' as const, tool_use_id: m.toolCallId, content: contentToText(m.content) }],
      });
    } else if (m.role === 'tool') {
      // 向后兼容（fenced 场景无 id）：工具结果作为 user 文本回灌
      out.push({ role: 'user', content: `${TOOL_RESULT_PREFIX}${contentToText(m.content)}` });
    } else {
      out.push({ role: m.role, content: toAnthropicContent(m.content) });
    }
  }
  return { system, messages: out };
}

/** 解析 Anthropic SSE 流，累积 thinking_delta（reasoning）、text_delta（content）与 tool_use 块并回调增量。 */
async function parseAnthropicSSE(
  stream: AsyncIterable<Uint8Array>,
  onChunk: (chunk: StreamChunk) => void,
  signal?: AbortSignal
): Promise<ChatCompletionResult> {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let reasoning = '';
  let content = '';
  const toolUses = new Map<number, ToolCallAccumulator>();

  for await (const value of stream) {
    if (signal?.aborted) break; // P0-3：中断后立即停止消费
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      // Anthropic SSE 为 `event:` + `data:` 两行；只处理 data 行
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      try {
        const obj = JSON.parse(data) as {
          type?: string;
          index?: number;
          content_block?: { type?: string; id?: string; name?: string };
          delta?: { type?: string; text?: string; thinking?: string; partial_json?: string };
        };
        if (obj.type === 'content_block_start' && obj.content_block?.type === 'tool_use') {
          toolUses.set(obj.index ?? 0, {
            id: obj.content_block.id ?? '',
            name: obj.content_block.name ?? '',
            args: '',
          });
        } else if (obj.type === 'content_block_delta' && obj.delta) {
          if (obj.delta.type === 'text_delta' && typeof obj.delta.text === 'string') {
            content += obj.delta.text;
            onChunk({ type: 'content', text: obj.delta.text });
          } else if (obj.delta.type === 'thinking_delta' && typeof obj.delta.thinking === 'string') {
            reasoning += obj.delta.thinking;
            onChunk({ type: 'reasoning', text: obj.delta.thinking });
          } else if (obj.delta.type === 'input_json_delta' && typeof obj.delta.partial_json === 'string') {
            const i = obj.index ?? 0;
            const acc = toolUses.get(i) ?? { id: '', name: '', args: '' };
            acc.args += obj.delta.partial_json;
            toolUses.set(i, acc);
          }
        }
      } catch {
        /* 忽略非 JSON 行（保持健壮） */
      }
    }
  }

  // P0-3：中断同样显式抛出，避免把半截内容当作正常完成
  if (signal?.aborted) throw abortReason(signal);

  const result: ChatCompletionResult = { reasoning, content };
  const nativeCalls = assembleToolCalls(toolUses);
  if (nativeCalls) result.toolCalls = nativeCalls;
  return result;
}

// ---------------------------------------------------------------------------
// Provider 工厂（P3.5+ 多点位）
// ---------------------------------------------------------------------------

export interface ProviderModelOptions {
  /** provider：openai（OpenAI 兼容，含 DeepSeek/通义/月之暗面/Ollama 等）| anthropic | auto（缺省=openai） */
  provider?: 'openai' | 'anthropic' | 'auto';
  baseURL?: string;
  apiKey: string;
  model?: string;
}

/** 依据 provider 选择模型适配器；缺省/auto 走 OpenAI 兼容（覆盖国产模型与本地推理服务）。 */
export function createModel(opts: ProviderModelOptions): ChatModel {
  const provider = opts.provider ?? 'auto';
  if (provider === 'anthropic') {
    return new AnthropicModel({ baseURL: opts.baseURL, apiKey: opts.apiKey, model: opts.model });
  }
  return new OpenAICompatibleModel({ baseURL: opts.baseURL, apiKey: opts.apiKey, model: opts.model });
}

/** 构建 OpenAI 兼容 chat/completions 请求体（含原生 tools）。 */
function toOpenAIBody(model: string, messages: ChatMessage[], opts: ChatStreamOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    stream: true,
    stream_options: { include_usage: false },
    messages: toOpenAIMessages(messages),
    temperature: opts.temperature ?? DEFAULT_TEMPERATURE,
  };
  // 只有**显式配置**了上限才发送：省略该字段时上限由服务端决定，而写死一个值等于替用户
  // 压低默认输出长度，顺带把"没配"和"配成同一个数"变成无法区分。
  if (opts.maxTokens !== undefined && opts.maxTokens > 0) {
    body.max_tokens = Math.round(opts.maxTokens);
  }
  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    body.tool_choice = 'auto';
  }
  return body;
}

/**
 * 统一 content → OpenAI 兼容内容。
 *
 * 纯文本**不加包装**：改成 `[{type:'text',...}]` 虽然同样合法，但会让改造前后
 * 每一轮的请求体逐字节不同 —— 一个"支持图片"的改动不该动到没有图片的请求。
 */
function toOpenAIContent(content: string | ChatContentPart[]): unknown {
  if (typeof content === 'string') return content;
  return content.map((p) =>
    p.type === 'text'
      ? { type: 'text', text: p.text }
      : { type: 'image_url', image_url: { url: `data:${p.mimeType};base64,${p.dataBase64}` } }
  );
}

/** 序列化 OpenAI 消息：assistant 的原生 tool_calls；tool 原生带 tool_call_id、fenced 兜底降级为 user 文本。 */
function toOpenAIMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: contentToText(m.content) || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id ?? '',
          type: 'function',
          function: { name: tc.tool, arguments: JSON.stringify(tc.input) },
        })),
      };
    }
    if (m.role === 'tool') {
      if (m.toolCallId) return { role: 'tool', tool_call_id: m.toolCallId, content: contentToText(m.content) };
      // fenced 兜底（无原生 tool_call id）：作为 user 文本回灌
      return { role: 'user', content: `${TOOL_RESULT_PREFIX}${contentToText(m.content)}` };
    }
    return { role: m.role, content: toOpenAIContent(m.content) };
  });
}

/** 构建 Anthropic /v1/messages 请求体（含原生 tools）。 */
function toAnthropicBody(
  model: string,
  opts: ChatStreamOptions,
  system: string,
  messages: Array<{ role: 'user' | 'assistant'; content: AnthropicContent }>
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    // Anthropic 把 max_tokens 列为必填 —— 不能像 OpenAI 兼容端点那样省略，故未配置时回落缺省值
    max_tokens:
      opts.maxTokens !== undefined && opts.maxTokens > 0 ? Math.round(opts.maxTokens) : DEFAULT_MAX_OUTPUT_TOKENS,
    // 温度区间两家不同（OpenAI 0–2 / Anthropic 0–1）：越界值**钳制**而不是原样发出，
    // 否则用户只会看到一个与自己的配置无关的上游 400。
    temperature: Math.min(1, Math.max(0, opts.temperature ?? DEFAULT_TEMPERATURE)),
    stream: true,
    system,
    messages,
  };
  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }
  return body;
}

/** 一次原生工具调用的流式累积状态（OpenAI 与 Anthropic 归一后共享）。 */
interface ToolCallAccumulator {
  id: string;
  name: string;
  args: string;
}

/** 把原生协议的 JSON 参数串解析为对象（失败或非对象时回退空对象）。 */
function parseArgsJson(args: string): Record<string, unknown> {
  if (!args) return {};
  try {
    const parsed = JSON.parse(args);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 把按 index 累积的原生工具调用归一为 ToolCall[]（按 index 排序；无调用返回 undefined）。 */
function assembleToolCalls(accs: Map<number, ToolCallAccumulator>): ToolCall[] | undefined {
  if (accs.size === 0) return undefined;
  return [...accs.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, acc]) => ({ tool: acc.name, input: parseArgsJson(acc.args), id: acc.id }));
}

/** 解析 OpenAI 兼容 SSE 流，累积 reasoning_content、content 与 tool_calls 增量并回调。 */
async function parseSSE(
  stream: AsyncIterable<Uint8Array>,
  onChunk: (chunk: StreamChunk) => void,
  signal?: AbortSignal
): Promise<ChatCompletionResult> {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let reasoning = '';
  let content = '';
  const toolCalls = new Map<number, ToolCallAccumulator>();

  for await (const value of stream) {
    // P0-3：被中断（取消 / 空闲超时）时立即停止消费，不再解析后续增量
    if (signal?.aborted) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]' || data === '') continue;
      try {
        const obj = JSON.parse(data) as {
          choices?: Array<{
            delta?: {
              reasoning_content?: unknown;
              content?: unknown;
              tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
            };
          }>;
        };
        const delta = obj.choices?.[0]?.delta;
        if (!delta) continue;
        const r = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : '';
        const c = typeof delta.content === 'string' ? delta.content : '';
        if (r) {
          reasoning += r;
          onChunk({ type: 'reasoning', text: r });
        }
        if (c) {
          content += c;
          onChunk({ type: 'content', text: c });
        }
        for (const tc of delta.tool_calls ?? []) {
          const i = tc.index ?? 0;
          const acc = toolCalls.get(i) ?? { id: '', name: '', args: '' };
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name = tc.function.name;
          if (tc.function?.arguments) acc.args += tc.function.arguments;
          toolCalls.set(i, acc);
        }
      } catch {
        /* 忽略非 JSON 行（保持健壮） */
      }
    }
  }

  // P0-3：因中断（取消 / 空闲超时）而提前退出时，必须把中断**显式抛给调用方**，
  // 否则会静默返回半截内容，模型调用失败被误判为"正常完成"。
  if (signal?.aborted) throw abortReason(signal);

  const result: ChatCompletionResult = { reasoning, content };
  const nativeCalls = assembleToolCalls(toolCalls);
  if (nativeCalls) result.toolCalls = nativeCalls;
  return result;
}

// ---------------------------------------------------------------------------
// Fake 模型（测试 / 集成）
// ---------------------------------------------------------------------------

/** 脚本化的一轮回复。 */
export interface FakeTurn {
  reasoning?: string;
  content?: string;
  /** 若提供，则附带一个 fenced 工具调用块（见 toolcall.ts） */
  toolcall?: { tool: string; input: Record<string, unknown> };
  /** 原生工具调用（function calling / tool_use，带 id） */
  toolCalls?: ToolCall[];
}

export type FakeResponder = (messages: ChatMessage[]) => FakeTurn;

/**
 * 可编程假模型：由 responder 根据消息序列决定每轮回复，并以流式方式
 * 回调 onChunk（模拟真实模型的增量到达）。
 */
export class FakeChatModel implements ChatModel {
  constructor(private readonly responder: FakeResponder, private readonly chunkSize = 6) {}

  async chat(messages: ChatMessage[], opts: ChatStreamOptions = {}): Promise<ChatCompletionResult> {
    const turn = this.responder(messages);
    const reasoning = turn.reasoning ?? '';
    const content = turn.toolcall ? formatToolCallContent(turn.toolcall) : (turn.content ?? '');

    for (const ch of chunkText(reasoning, this.chunkSize)) {
      if (opts.signal?.aborted) break;
      opts.onChunk?.({ type: 'reasoning', text: ch });
    }
    for (const ch of chunkText(content, this.chunkSize)) {
      if (opts.signal?.aborted) break;
      opts.onChunk?.({ type: 'content', text: ch });
    }
    return { reasoning, content, toolCalls: turn.toolCalls };
  }
}

function toolcallFence(): string {
  return 'toolcall';
}

/** 生成带 fenced 工具调用块的助手正文（与 toolcall.ts 的解析器约定一致）。 */
export function formatToolCallContent(call: { tool: string; input: Record<string, unknown> }): string {
  return '```' + toolcallFence() + '\n' + JSON.stringify(call) + '\n```\n';
}

function chunkText(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/**
 * 关键字驱动的假模型（集成冒烟用）：首轮按 prompt 关键字提出一个工具调用，
 * 收到 tool 结果后再给出一句话收尾。确定性、无网络。
 */
export function createKeywordFakeModel(): ChatModel {
  const responder: FakeResponder = (messages) => {
    const hasToolResult = messages.some((m) => m.role === 'tool');
    const userText = messages
      .filter((m) => m.role === 'user')
      .map((m) => contentToText(m.content))
      .join('\n');

    // P2-7 计划阶段：只读调研 -> 直接给出一份计划正文（不发起写入调用）。
    // 判定见 planMode.ts —— 标记与 realAgent 的 system 附加指令同源，不在这里另写一份字面量。
    // 入参显式投影成文本：planMode 只关心 system 文案，而"把内容当文本用"的出口只有
    // contentToText 一个。若反过来把 isPlanPhase 改成收多模态，planMode.ts 就得 import
    // model.ts，而 model.ts 已经 import 它 —— 又转回本模块开头注释里要避免的那个循环。
    if (isPlanPhase(messages.map((m) => ({ role: m.role, content: contentToText(m.content) })))) {
      return {
        reasoning: '计划模式：先做只读调研，产出一份计划供用户批准。',
        content:
          '## 计划\n\n1. 目标：按用户请求改动目标文件。\n2. 步骤：读取目标文件 -> 生成补丁 -> 提交审查。\n' +
          '3. 涉及文件：目标文件将被写入（路径见用户请求）。\n4. 风险：写入前会经过 Diff 审查，未获批准不会落盘。',
      };
    }

    if (hasToolResult) {
      const lastToolMsg = [...messages].reverse().find((m) => m.role === 'tool');
      const lastTool = lastToolMsg ? contentToText(lastToolMsg.content) : '';
      return { content: `工具已执行完毕：${lastTool.slice(0, 80)}` };
    }

    // 图片输入（P2-4）：把"模型侧究竟收到了几张图"变成**可从外部观察**的事实。
    // 假模型存在的意义就是把不可见的链路变得可断言 —— 冒烟脚本只能读 SSE 正文、
    // 看不见请求体，而 `[图片 N]` 位置标记只能证明文本到了，证明不了 image 内容块到了。
    const imageParts = messages.reduce(
      (n, m) => (m.role === 'user' && Array.isArray(m.content)
        ? n + m.content.filter((p) => p.type === 'image').length
        : n),
      0
    );
    if (imageParts > 0) {
      // 回显两件事：请求体里真有几个 image 内容块，以及文本侧留下的位置标记。
      // 后者证明"第 N 张"的位置信息确实到了模型，前者证明图片本身到了 —— 缺任何一半，
      // "支持图片输入"就只是个说法。
      // 注意 `[^\]]` 的转义：JS 里 `[^]]` **不是**"非 ]"（那是 Perl 语义），
      // 实际会被解析成"任意字符 + 字面 ]"，于是永远匹配不到 —— 正是踩过的坑。
      const markers = (userText.match(/\[图片 [0-9]+[^\]]*\]/g) || []).join(' ');
      return {
        reasoning: `请求体里有 ${imageParts} 个 image 内容块。`,
        content: `（fake real-agent）已收到 ${imageParts} 张图片：${markers}`,
      };
    }

    const file = findAttachmentPath(userText);
    if (/read|查看|读取/i.test(userText) && file) {
      return {
        reasoning: '用户需要读取文件内容，调用 read_file 工具。',
        toolcall: { tool: 'read_file', input: { path: file } },
      };
    }
    if (/修改|edit|write|替换|创建/i.test(userText) && file) {
      return {
        reasoning: '用户需要修改文件，生成补丁并提交审查。',
        toolcall: { tool: 'write_file', input: { path: file, content: 'REAL-DAEMON-WRITE' } },
      };
    }
    if (/bash|执行命令|run[\s-]?command/i.test(userText)) {
      // 命令刻意无引号/无括号：Windows cmd.exe 对嵌套引号解析不可靠，
      // 用 echo + cd/pwd 验证「命令真实执行 + cwd 被约束到工作区」。
      const bashCommand = process.platform === 'win32' ? 'echo SMOKE_BASH_OK && cd' : 'echo SMOKE_BASH_OK && pwd';
      return {
        reasoning: '用户需要执行 shell 命令，调用 bash_execute（真实 spawn，验证命令沙箱 cwd 约束）。',
        toolcall: { tool: 'bash_execute', input: { command: bashCommand } },
      };
    }
    return {
      reasoning: '未识别到明确工具意图，直接作答。',
      content: `（fake real-agent）已收到请求：${userText.slice(0, 120)}`,
    };
  };
  return new FakeChatModel(responder);
}

function findAttachmentPath(userText: string): string | undefined {
  const m = userText.match(/<file[^>]*path="([^"]+)"/);
  return m ? m[1] : undefined;
}