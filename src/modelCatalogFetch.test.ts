/**
 * 在线模型列表拉取的单测（全用假 fetch，不出网）。
 *
 * 钉住的行为：
 *  - 鉴权头只在有 Key 时出现（无 Key 时不编造一个空 Bearer）；
 *  - **只有 404 才换候选路径**：401/403 换路径是同一个结果，重试会拖慢并掩盖真因；
 *  - 失败原因必须能区分「Key 无效」「端点没有该接口」「断网」「超时」「返回不是列表」——
 *    因为面板要把这个原因原样说给用户听，含混的"请求失败"会把用户带偏。
 */
import { describe, expect, it } from 'vitest';
import {
  MODEL_FETCH_TIMEOUT_MS,
  type FetchLike,
  type ModelListResponse,
  fetchModelIds,
} from './modelCatalogFetch';

interface Call {
  url: string;
  headers: Record<string, string>;
}

function jsonResponse(status: number, body: unknown): ModelListResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** 记录调用并按 URL 返回预置响应的假 fetch */
function fakeFetch(table: Record<string, ModelListResponse>, calls: Call[]): FetchLike {
  return async (url, init) => {
    calls.push({ url, headers: init.headers });
    const hit = table[url];
    if (!hit) throw Object.assign(new Error(`unexpected url: ${url}`), { name: 'TypeError' });
    return hit;
  };
}

const LIST_OK = { object: 'list', data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] };

describe('在线拉取模型列表', () => {
  it('200 时返回 id 列表，并带上 Bearer 鉴权头', async () => {
    const calls: Call[] = [];
    const r = await fetchModelIds({
      candidates: ['https://api.deepseek.com/models'],
      apiKey: 'sk-test',
      fetchImpl: fakeFetch({ 'https://api.deepseek.com/models': jsonResponse(200, LIST_OK) }, calls),
    });

    expect(r.ok).toBe(true);
    expect(r.ids).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
    expect(r.endpoint).toBe('https://api.deepseek.com/models');
    expect(calls[0].headers.Authorization).toBe('Bearer sk-test');
    expect(calls[0].headers.Accept).toBe('application/json');
  });

  it('没有 Key 时不编造 Authorization 头（本地端点靠匿名放行）', async () => {
    const calls: Call[] = [];
    await fetchModelIds({
      candidates: ['http://127.0.0.1:11434/v1/models'],
      fetchImpl: fakeFetch(
        { 'http://127.0.0.1:11434/v1/models': jsonResponse(200, { data: ['llama3'] }) },
        calls
      ),
    });
    expect(calls[0].headers.Authorization).toBeUndefined();
  });

  it('首个候选 404 → 换下一条候选（/v1 与不带 /v1 两条路径都可能有效）', async () => {
    const calls: Call[] = [];
    const r = await fetchModelIds({
      candidates: ['https://api.deepseek.com/v1/models', 'https://api.deepseek.com/models'],
      apiKey: 'sk-test',
      fetchImpl: fakeFetch(
        {
          'https://api.deepseek.com/v1/models': jsonResponse(404, { error: 'not found' }),
          'https://api.deepseek.com/models': jsonResponse(200, LIST_OK),
        },
        calls
      ),
    });

    expect(r.ok).toBe(true);
    expect(r.endpoint).toBe('https://api.deepseek.com/models');
    expect(calls.map((c) => c.url)).toHaveLength(2);
  });

  it('401 不再试下一条候选：换路径也是同一个结果，重试只会拖慢并掩盖真因', async () => {
    const calls: Call[] = [];
    const r = await fetchModelIds({
      candidates: ['https://api.deepseek.com/v1/models', 'https://api.deepseek.com/models'],
      apiKey: 'sk-bad',
      fetchImpl: fakeFetch(
        { 'https://api.deepseek.com/v1/models': jsonResponse(401, { error: 'invalid key' }) },
        calls
      ),
    });

    expect(r).toEqual({ ok: false, ids: [], endpoint: 'https://api.deepseek.com/v1/models', failure: 'unauthorized', detail: 'HTTP 401' });
    expect(calls).toHaveLength(1);
  });

  it('403 / 500 / 两条候选都 404 各自给出确定原因', async () => {
    const opts = (status: number) => ({
      candidates: ['https://gw/models'],
      fetchImpl: fakeFetch({ 'https://gw/models': jsonResponse(status, {}) }, []),
    });
    expect((await fetchModelIds(opts(403))).failure).toBe('forbidden');
    expect((await fetchModelIds(opts(500))).failure).toBe('http');
    expect((await fetchModelIds(opts(500))).detail).toBe('HTTP 500');

    const r = await fetchModelIds({
      candidates: ['https://gw/v1/models', 'https://gw/models'],
      fetchImpl: fakeFetch(
        { 'https://gw/v1/models': jsonResponse(404, {}), 'https://gw/models': jsonResponse(404, {}) },
        []
      ),
    });
    expect(r.failure).toBe('not-found');
  });

  it('超时归为 timeout（不是"网络不可达"），且不会中断进程', async () => {
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });

    const r = await fetchModelIds({ candidates: ['https://gw/models'], timeoutMs: 10, fetchImpl: hang });
    expect(r.failure).toBe('timeout');
    expect(MODEL_FETCH_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('抛错（DNS/连接被拒）归为 network，并继续试下一条候选', async () => {
    const calls: Call[] = [];
    const flaky: FetchLike = async (url, init) => {
      calls.push({ url, headers: init.headers });
      if (url.endsWith('/v1/models')) throw new Error('getaddrinfo ENOTFOUND');
      return jsonResponse(200, LIST_OK);
    };
    const r = await fetchModelIds({
      candidates: ['https://gw/v1/models', 'https://gw/models'],
      fetchImpl: flaky,
    });
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('返回不是模型列表 → bad-payload（而不是假装成功给出空列表）', async () => {
    const r = await fetchModelIds({
      candidates: ['https://gw/models'],
      fetchImpl: fakeFetch({ 'https://gw/models': jsonResponse(200, { hello: 'world' }) }, []),
    });
    expect(r).toEqual({ ok: false, ids: [], endpoint: 'https://gw/models', failure: 'bad-payload' });

    const broken: ModelListResponse = {
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('invalid json');
      },
    };
    const r2 = await fetchModelIds({
      candidates: ['https://gw/models'],
      fetchImpl: async () => broken,
    });
    expect(r2.failure).toBe('bad-payload');
  });
});
