import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeChatModel, OpenAICompatibleModel } from './model';

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