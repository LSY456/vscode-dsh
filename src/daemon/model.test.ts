import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicModel, createModel, FakeChatModel, OpenAICompatibleModel } from './model';

function sseChunks(lines: string[]): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const l of lines) yield new TextEncoder().encode(l + '\n');
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('OpenAICompatibleModel', () => {
  it('解析 SSE 并分别累积 reasoning 与 content，请求负载正确', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return {
        ok: true,
        body: sseChunks([
          'data: {"choices":[{"delta":{"reasoning_content":"思考中"}}]}',
          'data: {"choices":[{"delta":{"content":"你好"}}]}',
          'data: {"choices":[{"delta":{"content":"世界"}}]}',
          'data: [DONE]',
        ]),
        text: async () => '',
      };
    });

    const model = new OpenAICompatibleModel({ baseURL: 'https://x/v1', apiKey: 'k', model: 'm' });
    const chunks: string[] = [];
    const res = await model.chat([{ role: 'user', content: 'hi' }], {
      onChunk: (c) => chunks.push(`${c.type}:${c.text}`),
    });

    expect(res.reasoning).toBe('思考中');
    expect(res.content).toBe('你好世界');
    expect(chunks).toEqual(['reasoning:思考中', 'content:你好', 'content:世界']);
    expect(calls[0].url).toBe('https://x/v1/chat/completions');
    expect(calls[0].body.model).toBe('m');
    expect(calls[0].body.stream).toBe(true);
  });

  it('缺省 baseURL/model 回退 DeepSeek', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { ok: true, body: sseChunks(['data: [DONE]']), text: async () => '' };
    });
    const model = new OpenAICompatibleModel({ apiKey: 'k' });
    await model.chat([{ role: 'user', content: 'x' }]);
    expect(calls[0].url).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(calls[0].body.model).toBe('deepseek-chat');
  });

  it('非 2xx 抛错并携带状态码', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: false,
      status: 401,
      body: null,
      text: async () => 'unauthorized',
    }));
    const model = new OpenAICompatibleModel({ apiKey: 'bad' });
    await expect(model.chat([{ role: 'user', content: 'x' }])).rejects.toThrow(/HTTP 401/);
  });
});

describe('FakeChatModel', () => {
  it('按 responder 流式输出；含 toolcall 时生成 fenced 块', async () => {
    const model = new FakeChatModel(
      () => ({ reasoning: 'R1', toolcall: { tool: 'read_file', input: { path: '/a' } } }),
      2
    );
    const chunks: string[] = [];
    const res = await model.chat([], { onChunk: (c) => chunks.push(`${c.type}:${c.text}`) });

    expect(res.reasoning).toBe('R1');
    expect(res.content).toContain('```toolcall');
    expect(res.content).toContain('"tool":"read_file"');
    expect(chunks.some((c) => c === 'reasoning:R1')).toBe(true);
  });
});

describe('AnthropicModel', () => {
  it('解析 Anthropic SSE：thinking_delta 归 reasoning、text_delta 归 content，并携带正确头与端点', async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', async (url: string, init: { headers: Record<string, string>; body: string }) => {
      calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return {
        ok: true,
        body: sseChunks([
          'event: message_start',
          'data: {"type":"message_start","message":{"id":"m1","content":[]}}',
          'event: content_block_delta',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"推理"}}',
          'event: content_block_delta',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}',
          'event: content_block_delta',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"世界"}}',
          'event: message_stop',
          'data: {"type":"message_stop"}',
        ]),
        text: async () => '',
      };
    });

    const model = new AnthropicModel({ baseURL: 'https://a.example', apiKey: 'ak', model: 'claude-x' });
    const chunks: string[] = [];
    const res = await model.chat([{ role: 'user', content: 'hi' }], {
      onChunk: (c) => chunks.push(`${c.type}:${c.text}`),
    });

    expect(res.reasoning).toBe('推理');
    expect(res.content).toBe('你好世界');
    expect(chunks).toEqual(['reasoning:推理', 'content:你好', 'content:世界']);
    expect(calls[0].url).toBe('https://a.example/v1/messages');
    expect(calls[0].headers['x-api-key']).toBe('ak');
    expect(calls[0].headers['anthropic-version']).toBe('2023-06-01');
    expect(calls[0].body.model).toBe('claude-x');
  });

  it('消息转换：system 置顶为顶层字段、tool 消息降级为 user；缺省端点/model 正确', async () => {
    let body: Record<string, unknown> = {};
    let url = '';
    vi.stubGlobal('fetch', async (u: string, init: { body: string }) => {
      url = u;
      body = JSON.parse(init.body);
      return { ok: true, body: sseChunks(['data: {"type":"message_stop"}']), text: async () => '' };
    });

    const model = new AnthropicModel({ apiKey: 'ak' });
    await model.chat([
      { role: 'system', content: 'SYS1' },
      { role: 'system', content: 'SYS2' },
      { role: 'user', content: 'hello' },
      { role: 'tool', content: 'tool=read_file\n结果内容' },
    ]);

    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(body.system).toBe('SYS1\n\nSYS2');
    expect(body.model).toBe('claude-3-5-sonnet-latest');
    expect(body.messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'user', content: '[工具结果]\ntool=read_file\n结果内容' },
    ]);
  });
});

describe('createModel 工厂', () => {
  it('按 provider 选择适配器：anthropic / openai / auto（缺省）', () => {
    expect(createModel({ provider: 'anthropic', apiKey: 'k' })).toBeInstanceOf(AnthropicModel);
    expect(createModel({ provider: 'openai', apiKey: 'k' })).toBeInstanceOf(OpenAICompatibleModel);
    expect(createModel({ apiKey: 'k' })).toBeInstanceOf(OpenAICompatibleModel);
    expect(createModel({ provider: 'auto', apiKey: 'k' })).toBeInstanceOf(OpenAICompatibleModel);
  });
});