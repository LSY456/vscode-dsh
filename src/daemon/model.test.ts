import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AnthropicModel,
  contentToText,
  createModel,
  describeHttpError,
  FakeChatModel,
  OpenAICompatibleModel,
  resolveProviderBaseURL,
} from './model';
import type { ChatMessage } from './model';

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
    expect(calls[0].body.model).toBe('deepseek-flash');
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

describe('pinned 是 daemon 内部标记，绝不能进请求体（批次 11-1）', () => {
  const pinnedMessages: ChatMessage[] = [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: 'U' },
    { role: 'assistant', content: '【已批准的计划】\n1. 改 a.txt', pinned: true },
    { role: 'user', content: '计划已获批准，请按上面的计划开始执行。', pinned: true },
  ];

  it('OpenAI 兼容端点：正文照发，pinned 字段不出现在负载里', async () => {
    let raw = '';
    vi.stubGlobal('fetch', async (_u: string, init: { body: string }) => {
      raw = init.body;
      return { ok: true, body: sseChunks(['data: [DONE]']), text: async () => '' };
    });
    await new OpenAICompatibleModel({ apiKey: 'k' }).chat(pinnedMessages);
    expect(raw).toContain('【已批准的计划】');
    expect(raw).not.toContain('pinned');
  });

  it('Anthropic 端点：正文照发，pinned 字段不出现在负载里', async () => {
    let raw = '';
    vi.stubGlobal('fetch', async (_u: string, init: { body: string }) => {
      raw = init.body;
      return { ok: true, body: sseChunks(['data: {"type":"message_stop"}']), text: async () => '' };
    });
    await new AnthropicModel({ apiKey: 'k' }).chat(pinnedMessages);
    expect(raw).toContain('【已批准的计划】');
    expect(raw).not.toContain('pinned');
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

describe('provider 与 baseURL 解耦（P1-3）', () => {
  const stubFetch = (sink: { url: string }) => {
    vi.stubGlobal('fetch', async (u: string) => {
      sink.url = u;
      return { ok: true, body: sseChunks(['data: {"type":"message_stop"}']), text: async () => '' };
    });
  };

  it('anthropic + 出厂缺省 base（DeepSeek）→ 换成 Anthropic 官方端点', () => {
    expect(resolveProviderBaseURL('anthropic', 'https://api.deepseek.com/v1')).toBe('https://api.anthropic.com');
    // 尾部斜杠、前后空白都不该影响判定
    expect(resolveProviderBaseURL('anthropic', '  https://api.deepseek.com/v1/  ')).toBe(
      'https://api.anthropic.com'
    );
  });

  it('anthropic + 未填 base → Anthropic 官方端点', () => {
    expect(resolveProviderBaseURL('anthropic', '')).toBe('https://api.anthropic.com');
    expect(resolveProviderBaseURL('anthropic', '   ')).toBe('https://api.anthropic.com');
    expect(resolveProviderBaseURL('anthropic', undefined)).toBe('https://api.anthropic.com');
  });

  it('用户显式填了别的地址 → 一律照用（含 DeepSeek 的 anthropic 兼容入口）', () => {
    // 判据是"等不等于出厂缺省值"，不是"域名像不像" —— 否则这条会被误替换
    expect(resolveProviderBaseURL('anthropic', 'https://api.deepseek.com/anthropic')).toBe(
      'https://api.deepseek.com/anthropic'
    );
    expect(resolveProviderBaseURL('anthropic', 'https://my.gateway.local/v1')).toBe('https://my.gateway.local/v1');
  });

  it('openai / auto 不动 base（未填时交回模型层回落 DeepSeek）', () => {
    expect(resolveProviderBaseURL('openai', 'https://api.deepseek.com/v1')).toBe('https://api.deepseek.com/v1');
    expect(resolveProviderBaseURL('auto', 'https://x/v1')).toBe('https://x/v1');
    expect(resolveProviderBaseURL('auto', '')).toBeUndefined();
    expect(resolveProviderBaseURL(undefined, undefined)).toBeUndefined();
  });

  it('真实请求 URL：切了 provider 不改 base，也不会拼出 /v1/v1/messages', async () => {
    const sink = { url: '' };
    stubFetch(sink);
    await createModel({
      provider: 'anthropic',
      baseURL: 'https://api.deepseek.com/v1',
      apiKey: 'k',
      model: 'claude-x',
    }).chat([{ role: 'user', content: 'hi' }]);
    expect(sink.url).toBe('https://api.anthropic.com/v1/messages');
    expect(sink.url).not.toContain('/v1/v1/');
  });

  it('Anthropic base 已带 /v1（照文档粘完整前缀）时不再重复拼接', async () => {
    const sink = { url: '' };
    stubFetch(sink);
    await new AnthropicModel({ baseURL: 'https://api.anthropic.com/v1', apiKey: 'k' }).chat([
      { role: 'user', content: 'hi' },
    ]);
    expect(sink.url).toBe('https://api.anthropic.com/v1/messages');
  });
});

describe('原生 function calling：OpenAI tool_calls', () => {
  it('请求体携带 tools（function 格式 + tool_choice auto）', async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      body = JSON.parse(init.body);
      return { ok: true, body: sseChunks(['data: [DONE]']), text: async () => '' };
    });
    const model = new OpenAICompatibleModel({ apiKey: 'k' });
    await model.chat([{ role: 'user', content: 'hi' }], {
      tools: [{ name: 'read_file', description: '读取文件', parameters: { type: 'object', properties: {} } }],
    });
    expect(body.tools).toEqual([
      { type: 'function', function: { name: 'read_file', description: '读取文件', parameters: { type: 'object', properties: {} } } },
    ]);
    expect(body.tool_choice).toBe('auto');
  });

  it('解析流式 tool_calls 增量，归一为 ToolCall（含 id 与入参对象）', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      body: sseChunks([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":""}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":"}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"/a\\"}"}}]}}]}',
        'data: [DONE]',
      ]),
      text: async () => '',
    }));
    const model = new OpenAICompatibleModel({ apiKey: 'k' });
    const res = await model.chat([{ role: 'user', content: '读' }]);
    expect(res.toolCalls).toEqual([{ tool: 'read_file', input: { path: '/a' }, id: 'call_1' }]);
  });

  it('多个 tool_calls 且 index 非连续时不错序、不漏槽', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      body: sseChunks([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"read_file","arguments":""}},{"index":2,"id":"call_b","type":"function","function":{"name":"list_dir","arguments":""}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"/a\\"}"}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":2,"function":{"arguments":"{\\"path\\":\\"/\\"}"}}]}}]}',
        'data: [DONE]',
      ]),
      text: async () => '',
    }));
    const model = new OpenAICompatibleModel({ apiKey: 'k' });
    const res = await model.chat([{ role: 'user', content: '读' }]);
    expect(res.toolCalls).toEqual([
      { tool: 'read_file', input: { path: '/a' }, id: 'call_a' },
      { tool: 'list_dir', input: { path: '/' }, id: 'call_b' },
    ]);
  });

  it('原生消息序列化：assistant tool_calls 与 tool 结果 tool_call_id', async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      body = JSON.parse(init.body);
      return { ok: true, body: sseChunks(['data: [DONE]']), text: async () => '' };
    });
    const model = new OpenAICompatibleModel({ apiKey: 'k' });
    await model.chat([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', toolCalls: [{ tool: 'read_file', input: { path: '/a' }, id: 'call_1' }] },
      { role: 'tool', content: 'tool=read_file\nTODO', toolCallId: 'call_1' },
    ]);
    expect(body.messages).toEqual([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"/a"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'tool=read_file\nTODO' },
    ]);
  });
});

describe('原生 function calling：Anthropic tool_use', () => {
  it('请求体携带 tools（input_schema 格式）', async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      body = JSON.parse(init.body);
      return { ok: true, body: sseChunks(['data: {"type":"message_stop"}']), text: async () => '' };
    });
    const model = new AnthropicModel({ apiKey: 'ak' });
    await model.chat([{ role: 'user', content: 'hi' }], {
      tools: [{ name: 'read_file', description: '读取文件', parameters: { type: 'object', properties: {} } }],
    });
    expect(body.tools).toEqual([
      { name: 'read_file', description: '读取文件', input_schema: { type: 'object', properties: {} } },
    ]);
  });

  it('解析 tool_use 块（content_block_start + input_json_delta）为 ToolCall', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      body: sseChunks([
        'event: content_block_start',
        'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"read_file","input":{}}}',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"/a\\"}"}}',
        'event: message_stop',
        'data: {"type":"message_stop"}',
      ]),
      text: async () => '',
    }));
    const model = new AnthropicModel({ apiKey: 'ak' });
    const res = await model.chat([{ role: 'user', content: '读' }]);
    expect(res.toolCalls).toEqual([{ tool: 'read_file', input: { path: '/a' }, id: 'toolu_1' }]);
  });

  it('tool_use 前有 text block 时 index 非连续仍正确归一', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      body: sseChunks([
        'event: content_block_start',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"我先读取。"}}',
        'event: content_block_start',
        'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"read_file","input":{}}}',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"/a\\"}"}}',
        'event: message_stop',
        'data: {"type":"message_stop"}',
      ]),
      text: async () => '',
    }));
    const model = new AnthropicModel({ apiKey: 'ak' });
    const res = await model.chat([{ role: 'user', content: '读' }]);
    expect(res.content).toBe('我先读取。');
    expect(res.toolCalls).toEqual([{ tool: 'read_file', input: { path: '/a' }, id: 'toolu_1' }]);
  });

  it('原生消息序列化：assistant tool_use 块与 tool 结果 tool_result 块', async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      body = JSON.parse(init.body);
      return { ok: true, body: sseChunks(['data: {"type":"message_stop"}']), text: async () => '' };
    });
    const model = new AnthropicModel({ apiKey: 'ak' });
    await model.chat([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', toolCalls: [{ tool: 'read_file', input: { path: '/a' }, id: 'toolu_1' }] },
      { role: 'tool', content: 'tool=read_file\nTODO', toolCallId: 'toolu_1' },
    ]);
    expect(body.messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: '/a' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'tool=read_file\nTODO' }] },
    ]);
  });
});

describe('模型请求空闲超时（P0-3）', () => {
  /** 构造一个"静默流"：永不产出任何增量，直到 signal abort 才结束。 */
  function silentUntilAbort(signal?: AbortSignal): AsyncIterable<Uint8Array> {
    return {
      async *[Symbol.asyncIterator]() {
        if (!signal) {
          await new Promise(() => {}); // 无 signal：真永久挂起
          return;
        }
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    };
  }

  it('OpenAI：长时间无增量 -> TimeoutError（而非永久挂起）', async () => {
    let captured: AbortSignal | undefined;
    vi.stubGlobal('fetch', async (_url: string, init: { signal?: AbortSignal }) => {
      captured = init.signal;
      return { ok: true, body: silentUntilAbort(init.signal), text: async () => '' };
    });
    const model = new OpenAICompatibleModel({ apiKey: 'k' });
    await expect(
      model.chat([{ role: 'user', content: 'x' }], { idleTimeoutMs: 40 })
    ).rejects.toThrow(/空闲超时/);
    expect(captured?.aborted).toBe(true);
  });

  it('Anthropic：长时间无增量 -> TimeoutError', async () => {
    vi.stubGlobal('fetch', async (_url: string, init: { signal?: AbortSignal }) => ({
      ok: true,
      body: silentUntilAbort(init.signal),
      text: async () => '',
    }));
    const model = new AnthropicModel({ apiKey: 'k' });
    await expect(
      model.chat([{ role: 'user', content: 'x' }], { idleTimeoutMs: 40 })
    ).rejects.toThrow(/空闲超时/);
  });

  it('有增量到达则重置空闲计时（不会误杀长回答）', async () => {
    vi.stubGlobal('fetch', async (_url: string, init: { signal?: AbortSignal }) => ({
      ok: true,
      // 分 3 批、批间隔 30ms；总量远超 80ms，但每批都在 80ms 空闲阈值内
      body: (async function* () {
        const enc = new TextEncoder();
        for (let i = 0; i < 3; i++) {
          await new Promise((r) => setTimeout(r, 30));
          if (init.signal?.aborted) return;
          yield enc.encode(`data: {"choices":[{"delta":{"content":"c${i}"}}]}\n`);
        }
        yield enc.encode('data: [DONE]\n');
      })(),
      text: async () => '',
    }));
    const model = new OpenAICompatibleModel({ apiKey: 'k' });
    const res = await model.chat([{ role: 'user', content: 'x' }], { idleTimeoutMs: 80 });
    expect(res.content).toBe('c0c1c2');
  });

  it('idleTimeoutMs <= 0 关闭空闲超时（不因静默而中断）', async () => {
    vi.stubGlobal('fetch', async (_url: string, init: { signal?: AbortSignal }) => ({
      ok: true,
      body: (async function* () {
        await new Promise((r) => setTimeout(r, 50));
        if (init.signal?.aborted) return;
        yield new TextEncoder().encode('data: {"choices":[{"delta":{"content":"late"}}]}\n');
        yield new TextEncoder().encode('data: [DONE]\n');
      })(),
      text: async () => '',
    }));
    const model = new OpenAICompatibleModel({ apiKey: 'k' });
    const res = await model.chat([{ role: 'user', content: 'x' }], { idleTimeoutMs: 0 });
    expect(res.content).toBe('late');
  });

  it('调用方取消 -> AbortError（与超时区分）', async () => {
    vi.stubGlobal('fetch', async (_url: string, init: { signal?: AbortSignal }) => ({
      ok: true,
      body: silentUntilAbort(init.signal),
      text: async () => '',
    }));
    const ctrl = new AbortController();
    const model = new OpenAICompatibleModel({ apiKey: 'k' });
    const p = model.chat([{ role: 'user', content: 'x' }], { signal: ctrl.signal, idleTimeoutMs: 5000 });
    setTimeout(() => ctrl.abort(), 20);
    await expect(p).rejects.toThrow(/已取消/);
  });
});

describe('describeHttpError：HTTP 失败要给出可执行的原因', () => {
  it('402 余额不足：说清原因，且不再把用户往"检查配置"上带', () => {
    // 回归：前端曾统一补一句"请检查 apiKey 与 model 配置"，
    // 而上游 402 是账号没钱，与配置无关 —— 实测把用户带偏过。
    const msg = describeHttpError(
      402,
      '{"error":{"message":"Insufficient Balance","type":"unknown_error","code":"invalid_request_error"}}'
    ).message;
    expect(msg).toContain('HTTP 402');
    expect(msg).toContain('余额不足');
    expect(msg).toContain('Insufficient Balance');
    expect(msg).not.toContain('apiKey');
  });

  it('401 才是配置问题：明确指向 dsh.apiKey', () => {
    const msg = describeHttpError(401, 'unauthorized').message;
    expect(msg).toContain('HTTP 401');
    expect(msg).toContain('dsh.apiKey');
  });

  it('429 提示限流重试；5xx 归为上游异常', () => {
    expect(describeHttpError(429, '').message).toContain('限流');
    expect(describeHttpError(503, '').message).toContain('上游服务异常');
  });

  it('从原始 JSON 里掏出人话，并截断超长非 JSON 正文', () => {
    expect(describeHttpError(400, '{"message":"bad payload"}').message).toContain('bad payload');
    const long = describeHttpError(400, 'x'.repeat(500)).message;
    expect(long).toContain('上游返回：' + 'x'.repeat(120) + '…');
  });

  it('响应体为空时只报状态码，不留悬空的冒号', () => {
    expect(describeHttpError(500, '').message).not.toMatch(/：$/);
  });
});

describe('采样参数可配（批次 2）', () => {
  /** 捕获每次请求体（fetch 被 stub 掉，不出网）。 */
  function capture(): Array<Record<string, unknown>> {
    const calls: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      calls.push(JSON.parse(init.body));
      return { ok: true, body: sseChunks(['data: [DONE]']), text: async () => '' };
    });
    return calls;
  }

  it('OpenAI 兼容：温度未配置时沿用缺省 0.2，配置后原样发送', async () => {
    const calls = capture();
    const model = new OpenAICompatibleModel({ apiKey: 'k' });
    await model.chat([{ role: 'user', content: 'x' }]);
    expect(calls[0].temperature).toBe(0.2);
    await model.chat([{ role: 'user', content: 'x' }], { temperature: 1.1 });
    expect(calls[1].temperature).toBe(1.1);
  });

  it('OpenAI 兼容：未配置 maxTokens 时**不发送**该字段（上限交给服务端）', async () => {
    const calls = capture();
    const model = new OpenAICompatibleModel({ apiKey: 'k' });

    await model.chat([{ role: 'user', content: 'x' }]);
    expect('max_tokens' in calls[0]).toBe(false);
    // 0 / 负数 = "不指定"的另一种写法，同样不发送（而不是真去要 0 个 token）
    await model.chat([{ role: 'user', content: 'x' }], { maxTokens: 0 });
    expect('max_tokens' in calls[1]).toBe(false);
    // 配了才发，且取整（部分端点不接受小数）
    await model.chat([{ role: 'user', content: 'x' }], { maxTokens: 2048.4 });
    expect(calls[2].max_tokens).toBe(2048);
  });

  it('Anthropic：max_tokens 必填故未配置时回落 4096；温度钳制到 0–1', async () => {
    const calls = capture();
    const model = new AnthropicModel({ baseURL: 'https://a.example', apiKey: 'ak', model: 'claude-x' });

    await model.chat([{ role: 'user', content: 'x' }]);
    expect(calls[0].max_tokens).toBe(4096);
    expect(calls[0].temperature).toBe(0.2); // 与 OpenAI 链路对齐（此前该链路不发送温度）

    await model.chat([{ role: 'user', content: 'x' }], { maxTokens: 8000, temperature: 1.5 });
    expect(calls[1].max_tokens).toBe(8000);
    // OpenAI 区间是 0–2，Anthropic 只到 1：越界**钳制**而不是原样发出 ——
    // 原样发出是必然 400，而用户只会看到"上游报错"，无从归因到自己的配置。
    expect(calls[1].temperature).toBe(1);

    await model.chat([{ role: 'user', content: 'x' }], { temperature: -3 });
    expect(calls[2].temperature).toBe(0);
  });
});
/**
 * 多模态消息（P2-4 图片输入）。
 *
 * 这里锁的是两件事：
 *  1. **两家的线上格式**：OpenAI 兼容要 `image_url` 的 data URL，Anthropic 要 `source.base64`
 *     块 —— 上层只认一种表示（ChatContentPart），差异必须停在各自的序列化函数里；
 *  2. **没有图片时请求体逐字节不变**：纯文本仍是裸字符串，不包装成 `[{type:'text'}]`。
 *     一个"新增图片能力"的改动若顺手改了所有请求的形状，回归就只能靠肉眼看了。
 */
describe('多模态消息序列化（批次 6）', () => {
  const PNG = 'iVBORw0KGgo='; // 8 字节 PNG 头，base64 形态合法
  const withImage = [
    { type: 'text' as const, text: '看这个报错' },
    { type: 'image' as const, mimeType: 'image/png', dataBase64: PNG },
  ];

  /** 捕获请求体（fetch 被 stub 掉，不出网）。 */
  function capture(): Array<Record<string, unknown>> {
    const calls: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      calls.push(JSON.parse(init.body));
      return { ok: true, body: sseChunks(['data: [DONE]']), text: async () => '' };
    });
    return calls;
  }

  describe('contentToText：把内容当文本用的唯一出口', () => {
    it('字符串原样返回', () => {
      expect(contentToText('hi')).toBe('hi');
    });

    it('数组只拼文本块，图片被丢弃（图片不是"文本"）', () => {
      expect(contentToText(withImage)).toBe('看这个报错');
      expect(
        contentToText([
          { type: 'image', mimeType: 'image/png', dataBase64: PNG },
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' },
        ])
      ).toBe('a\nb');
    });

    it('只有图片时得到空串（不抛出、不产出 "undefined" 之类字样）', () => {
      expect(contentToText([{ type: 'image', mimeType: 'image/png', dataBase64: PNG }])).toBe('');
    });
  });

  describe('OpenAI 兼容', () => {
    it('图文混排 -> text 块 + image_url 的 data URL', async () => {
      const calls = capture();
      const model = new OpenAICompatibleModel({ apiKey: 'k' });
      await model.chat([{ role: 'user', content: withImage }]);

      expect((calls[0].messages as any[])[0]).toEqual({
        role: 'user',
        content: [
          { type: 'text', text: '看这个报错' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } },
        ],
      });
    });

    it('纯文本仍是**裸字符串**：不包装成内容块数组（无图片的请求体逐字节不变）', async () => {
      const calls = capture();
      const model = new OpenAICompatibleModel({ apiKey: 'k' });
      await model.chat([{ role: 'user', content: 'hi' }]);
      expect((calls[0].messages as any[])[0].content).toBe('hi');
      expect(typeof (calls[0].messages as any[])[0].content).toBe('string');
    });

    it('assistant 原生 tool_calls 与 tool 结果也走 contentToText（图片不会漏成 "[object Object]"）', async () => {
      const calls = capture();
      const model = new OpenAICompatibleModel({ apiKey: 'k' });
      await model.chat([
        { role: 'user', content: withImage },
        {
          role: 'assistant',
          content: withImage,
          toolCalls: [{ id: 'c1', tool: 'read_file', input: { path: 'a.ts' } }],
        },
        { role: 'tool', content: withImage, toolCallId: 'c1' },
      ]);

      const messages = calls[0].messages as any[];
      expect(messages[1].content).toBe('看这个报错');
      expect(messages[1].tool_calls[0].id).toBe('c1');
      expect(messages[2].content).toBe('看这个报错');
      expect(JSON.stringify(messages)).not.toContain('[object Object]');
    });
  });

  describe('Anthropic', () => {
    const anthropic = () => new AnthropicModel({ baseURL: 'https://a.example', apiKey: 'ak', model: 'claude-x' });

    it('图文混排 -> text 块 + base64 source 块（media_type 逐字传递）', async () => {
      const calls = capture();
      await anthropic().chat([{ role: 'user', content: withImage }]);

      expect((calls[0].messages as any[])[0]).toEqual({
        role: 'user',
        content: [
          { type: 'text', text: '看这个报错' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
        ],
      });
    });

    it('用 base64 源而**不是** url：图片字节来自本机，没有也不该有可指的外部地址', async () => {
      const calls = capture();
      await anthropic().chat([{ role: 'user', content: withImage }]);
      const block = (calls[0].messages as any[])[0].content[1];
      expect(block.source.type).toBe('base64');
      expect(JSON.stringify(calls[0])).not.toContain('"url"');
      expect(JSON.stringify(calls[0])).not.toContain('data:image');
    });

    it('纯文本仍是裸字符串', async () => {
      const calls = capture();
      await anthropic().chat([{ role: 'user', content: 'hi' }]);
      expect((calls[0].messages as any[])[0].content).toBe('hi');
    });

    it('system 是数组时只取文本：顶层 system 字段只能是字符串', async () => {
      const calls = capture();
      await anthropic().chat([
        { role: 'system', content: withImage },
        { role: 'user', content: 'hi' },
      ]);
      expect(calls[0].system).toBe('看这个报错');
    });

    it('assistant tool_use 的正文取自文本块（与 OpenAI 链路同源）', async () => {
      const calls = capture();
      await anthropic().chat([
        { role: 'user', content: 'x' },
        {
          role: 'assistant',
          content: withImage,
          toolCalls: [{ id: 'tu1', tool: 'read_file', input: {} }],
        },
      ]);
      const blocks = (calls[0].messages as any[])[1].content;
      expect(blocks[0]).toEqual({ type: 'text', text: '看这个报错' });
      expect(blocks[1]).toEqual({ type: 'tool_use', id: 'tu1', name: 'read_file', input: {} });
    });

    it('tool 结果回灌为 tool_result 时取文本（工具结果是文本，不存在图片）', async () => {
      const calls = capture();
      await anthropic().chat([
        { role: 'user', content: 'x' },
        { role: 'tool', content: withImage, toolCallId: 'tu1' },
      ]);
      expect((calls[0].messages as any[])[1]).toEqual({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu1', content: '看这个报错' }],
      });
    });
  });
});
