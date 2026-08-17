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

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

export type StreamChunkType = 'reasoning' | 'content';

export interface StreamChunk {
  type: StreamChunkType;
  text: string;
}

export interface ChatCompletionResult {
  /** 思维链文本（可为空） */
  reasoning: string;
  /** 回答正文（包含可能的工具调用块） */
  content: string;
}

export interface ChatStreamOptions {
  temperature?: number;
  signal?: AbortSignal;
  /** 每个增量到达时回调（reasoning 与 content 分别触发） */
  onChunk?: (chunk: StreamChunk) => void;
}

export interface ChatModel {
  chat(messages: ChatMessage[], opts?: ChatStreamOptions): Promise<ChatCompletionResult>;
}

export interface OpenAIModelOptions {
  baseURL?: string;
  apiKey: string;
  model?: string;
}

const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';
const DEFAULT_MODEL = 'deepseek-chat';

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
    const res = await fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        stream: true,
        stream_options: { include_usage: false },
        messages,
        temperature: opts.temperature ?? 0.2,
      }),
      signal: opts.signal,
    });

    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => '');
      throw new Error(`模型请求失败 HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    return parseSSE(res.body as unknown as AsyncIterable<Uint8Array>, opts.onChunk ?? (() => {}));
  }
}

/** 解析 OpenAI 兼容 SSE 流，累积 reasoning_content 与 content 并回调增量。 */
async function parseSSE(
  stream: AsyncIterable<Uint8Array>,
  onChunk: (chunk: StreamChunk) => void
): Promise<ChatCompletionResult> {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let reasoning = '';
  let content = '';

  for await (const value of stream) {
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
          choices?: Array<{ delta?: { reasoning_content?: unknown; content?: unknown } }>;
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
      } catch {
        /* 忽略非 JSON 行（保持健壮） */
      }
    }
  }
  return { reasoning, content };
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
    return { reasoning, content };
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
      .map((m) => m.content)
      .join('\n');

    if (hasToolResult) {
      const lastTool = [...messages].reverse().find((m) => m.role === 'tool')?.content ?? '';
      return { content: `工具已执行完毕：${lastTool.slice(0, 80)}` };
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