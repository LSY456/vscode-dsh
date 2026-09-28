/**
 * 在线拉取模型列表（`GET {baseURL}/models`）。
 *
 * 与 `modelCatalog.ts` 的分工：那边是纯策略/文案，这边只管"发一次请求并把结果
 * 归一化成「成功拿到 id 列表」或「失败原因」"，不做任何 UI 决策。
 *
 * 设计要点：
 *  - `fetchImpl` 可注入 → 单测用假体覆盖 200 / 404 换候选 / 401 / 超时 / 脏返回；
 *  - 超时用 AbortController + setTimeout（而非 `AbortSignal.timeout`），
 *    定时器在 finally 里清掉，避免测试进程里留下悬挂 timer；
 *  - **只有 404 才继续试下一个候选路径**：401/403/5xx 换路径也是同一个结果，
 *    再试一次只会让用户多等几秒、并掩盖真正的失败原因。
 */
import { ModelFetchFailure, parseModelIds } from './modelCatalog';

/** 默认超时：模型列表响应很小，6s 足够；超时即视为网络问题并回退内置快照。 */
export const MODEL_FETCH_TIMEOUT_MS = 6000;

export interface ModelListResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal }
) => Promise<ModelListResponse>;

export interface FetchModelIdsOptions {
  /** 按顺序尝试的候选端点（见 modelEndpointCandidates） */
  candidates: string[];
  apiKey?: string;
  timeoutMs?: number;
  /** 测试注入用；缺省走全局 fetch（VSCode 扩展宿主为 Node 18+，有全局 fetch） */
  fetchImpl?: FetchLike;
}

export interface FetchModelIdsResult {
  ok: boolean;
  ids: string[];
  /** 命中（或最后尝试）的端点 URL */
  endpoint?: string;
  failure?: ModelFetchFailure;
  /** 补在失败文案里的细节，如 `HTTP 401` */
  detail?: string;
}

export async function fetchModelIds(opts: FetchModelIdsOptions): Promise<FetchModelIdsResult> {
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : MODEL_FETCH_TIMEOUT_MS;
  const doFetch = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (typeof doFetch !== 'function') {
    return { ok: false, ids: [], failure: 'network', detail: '当前运行环境无 fetch' };
  }

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;

  let last: FetchModelIdsResult = { ok: false, ids: [], failure: 'network' };

  for (const url of opts.candidates) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: ModelListResponse;
    try {
      res = await doFetch(url, { headers, signal: controller.signal });
    } catch (err) {
      last = { ok: false, ids: [], endpoint: url, ...classifyThrown(err) };
      continue;
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      last = {
        ok: false,
        ids: [],
        endpoint: url,
        failure: classifyStatus(res.status),
        detail: `HTTP ${res.status}`,
      };
      if (res.status !== 404) return last;
      continue;
    }

    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      return { ok: false, ids: [], endpoint: url, failure: 'bad-payload' };
    }
    const ids = parseModelIds(payload);
    if (ids.length === 0) return { ok: false, ids: [], endpoint: url, failure: 'bad-payload' };
    return { ok: true, ids, endpoint: url };
  }

  return last;
}

function classifyStatus(status: number): ModelFetchFailure {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not-found';
  return 'http';
}

function classifyThrown(err: unknown): { failure: ModelFetchFailure } {
  const name = (err as { name?: unknown } | null)?.name;
  if (name === 'AbortError' || name === 'TimeoutError') return { failure: 'timeout' };
  return { failure: 'network' };
}
