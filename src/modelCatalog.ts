/**
 * 可选模型目录 —— 模型设置面板里「模型名」下拉的**唯一数据源**。
 *
 * 为什么要有它：模型名是易错且会变动的**外部事实**。
 *  - 让用户手写字符串，错一个字母就是一次必然失败的请求；
 *  - 更糟的是模型名会"静默过期"：DeepSeek 的 `deepseek-chat` / `deepseek-reasoner`
 *    已于 2026/07/24 弃用（官方文档现已只列 `deepseek-flash` / `deepseek-v4-pro`），
 *    沿用旧名的配置会直接报错，而用户无从得知。
 * 因此模型名改为**下拉选择**，候选列表有三个来源，按优先级：
 *
 *   1. 在线（首选）：`GET {baseURL}/models`，OpenAI 兼容协议，
 *      官方文档 https://api-docs.deepseek.com/api/list-models 。
 *      官方一上架新模型，下次打开设置面板就会自动出现在下拉里 —— 这就是"自动更新"。
 *   2. 内置快照：`BUILTIN_DEEPSEEK_MODELS`（无 Key / 断网 / 端点不通时的兜底）。
 *   3. 兜底中的兜底：**当前配置值本身**。列表里没有它时也要保留成可选项，
 *      绝不因为"不在列表里"就把用户已经配好、可能正在用的模型名悄悄换掉。
 *      （用户只有在**主动**选择另一个模型时，配置才会变。）
 *
 * 本模块是纯函数模块：不 import vscode、不发网络请求，故可被单测覆盖；
 * 发请求的部分在 `modelCatalogFetch.ts`，面板接线在 `webviewPanel.ts`。
 */

/** 内置快照用的默认模型名 = DeepSeek 官方 "Your First API Call" 的首个推荐值。 */
export const DEFAULT_MODEL_ID = 'deepseek-flash';

/** OpenAI 兼容端点缺省 base（与 daemon 侧 DEFAULT_BASE_URL 同口径）。 */
export const DEFAULT_MODEL_BASE_URL = 'https://api.deepseek.com/v1';

/** 内置快照的取材日期。UI 会把它显式展示出来，避免"快照被当成实时列表"。 */
export const BUILTIN_AS_OF = '2026-09-28';

/** 在线列表的缓存有效期：24h。到期后下一次打开设置面板重新拉取。 */
export const MODEL_CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

export interface BuiltinModel {
  id: string;
  /** 下拉里的显示文案：左侧栏只有 ~340px，所以要短 */
  label: string;
}

/**
 * 内置快照（2026-09-28 取自 https://api-docs.deepseek.com/quick_start/pricing ）：
 *  - `deepseek-flash`  = DeepSeek-V4.1-Flash，1M 上下文，支持思考模式
 *  - `deepseek-v4-pro` = DeepSeek-V4-Pro，能力更强、单价更高（约 Flash 的 3 倍）
 *
 * 已弃用（2026/07/24）的 `deepseek-chat` / `deepseek-reasoner` **故意不列入** ——
 * 列进去等于继续引导用户选一个会报错的模型名。老配置里的旧名字不会被丢掉，
 * 而是由 `buildModelCatalog` 作为「当前配置」项保留下来并标注出来。
 */
export const BUILTIN_DEEPSEEK_MODELS: readonly BuiltinModel[] = [
  { id: 'deepseek-flash', label: 'deepseek-flash（快速 · 1M）' },
  { id: 'deepseek-v4-pro', label: 'deepseek-v4-pro（强推理）' },
];

/** 拉取在线列表失败的原因。`no-key` 由策略层给出（压根没发请求），其余来自 fetch 层。 */
export type ModelFetchFailure =
  | 'no-key'
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'http'
  | 'network'
  | 'timeout'
  | 'bad-payload';

/** 列表来源：在线本次拉到 / 在线缓存 / 内置快照。 */
export type ModelCatalogSource = 'live' | 'cache' | 'builtin';

/** 单个下拉项的来源，便于断言与排查（UI 不依赖它做样式）。 */
export type ModelOptionSource = 'live' | 'builtin' | 'current';

export interface ModelOption {
  id: string;
  label: string;
  source: ModelOptionSource;
}

export interface ModelCatalogMeta {
  source: ModelCatalogSource;
  /** 在线列表来自哪个端点（host；不含 key、不含 query，可安全展示） */
  endpointHost: string;
  /** 最近一次**成功**在线拉取的时间戳（source = cache/live 时有值） */
  fetchedAt?: number;
  /** source = builtin 时的失败原因 */
  failure?: ModelFetchFailure;
  /** 失败原因的补充（如 `HTTP 401`）；**只放状态码这类信息，绝不放 key** */
  failureDetail?: string;
  /** 是否已配置 API Key（用来区分"没配"与"配了但被拒"） */
  hasApiKey: boolean;
}

export interface ModelCatalog {
  models: ModelOption[];
  /** 给用户看的一行来源说明（文案唯一出口在本模块） */
  hint: string;
}

/** 在线列表的缓存体（存 globalState；`baseURL` 变了即视为失效）。 */
export interface ModelCatalogCache {
  /** 归一化后的 base（缓存归属判定用；命中路径可能是候选里的另一条） */
  baseURL: string;
  fetchedAt: number;
  models: string[];
  /** 实际命中并返回列表的 URL（排障用） */
  endpoint?: string;
}

// ---------------------------------------------------------------------------
// 端点推导
// ---------------------------------------------------------------------------

/** 归一化 base：去首尾空白、去末尾斜杠；空值回落缺省端点。 */
export function normalizeModelBaseUrl(baseURL?: string): string {
  const trimmed = (baseURL ?? '').trim().replace(/\/+$/, '');
  return trimmed || DEFAULT_MODEL_BASE_URL;
}

/** 是否 DeepSeek 官方端点（空值 = 用缺省端点，也算官方）。 */
export function isOfficialDeepSeekEndpoint(baseURL?: string): boolean {
  try {
    return new URL(normalizeModelBaseUrl(baseURL)).hostname.toLowerCase() === 'api.deepseek.com';
  } catch {
    return false;
  }
}

/** URL 的 host（拿不到就原样返回，供日志/提示展示）。 */
export function endpointHostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * 候选列表端点，按顺序尝试，任一成功即用。
 *
 * 官方文档写的是 `https://api.deepseek.com/models`，而本仓库的缺省 base 带 `/v1`
 * 后缀（官方也把 `/v1` 记为兼容别名），两个都可能有效 —— 所以以 `/v1`、`/anthropic`
 * 结尾时追加一条"去掉该后缀"的候选。只在**这两种已知后缀**下追加：
 * 自定义网关的路径无法猜测，乱试它的站点根只会拿到一份无关的列表。
 */
export function modelEndpointCandidates(baseURL?: string): string[] {
  const base = normalizeModelBaseUrl(baseURL);
  const out = [`${base}/models`];
  const stripped = base.replace(/\/(?:v1|anthropic)$/i, '');
  if (stripped !== base) out.push(`${stripped}/models`);
  return out;
}

// ---------------------------------------------------------------------------
// 响应解析 / 策略
// ---------------------------------------------------------------------------

/**
 * 解析 `/models` 响应，取出模型 id。
 * 兼容 `{data:[{id}]}`（OpenAI 规范）、`{data:["id"]}`、`{models:[...]}` 与裸数组；
 * 去空白、去重、保序；形状不对时返回空数组（由调用方按 bad-payload 处理）。
 */
export function parseModelIds(payload: unknown): string[] {
  const raw = pickRawModelList(payload);
  const out: string[] = [];
  for (const item of raw) {
    let id = '';
    if (typeof item === 'string') id = item;
    else if (item && typeof item === 'object') {
      const candidate = (item as { id?: unknown }).id;
      if (typeof candidate === 'string') id = candidate;
    }
    const trimmed = id.trim();
    if (trimmed && out.indexOf(trimmed) < 0) out.push(trimmed);
  }
  return out;
}

function pickRawModelList(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    const obj = payload as { data?: unknown; models?: unknown };
    if (Array.isArray(obj.data)) return obj.data;
    if (Array.isArray(obj.models)) return obj.models;
  }
  return [];
}

/**
 * 该不该发这次在线请求。
 *
 * 官方 `/models` 需要 Bearer 鉴权，没配 Key 时发出去必然是 401 —— 白等一次超时，
 * 还会把"没配 Key"说成"接口报错"，把用户带偏。自定义 / 本地端点（Ollama、LM Studio、
 * 内网网关）常常允许匿名 `/models`，那就照发。
 */
export function shouldAttemptModelFetch(opts: { hasApiKey: boolean; officialBase: boolean }): boolean {
  return opts.hasApiKey || !opts.officialBase;
}

/** 缓存在 TTL 内、且属于同一个 base、且非空 → 可直接用，不必再打网络。 */
export function isModelCatalogCacheFresh(
  cache: ModelCatalogCache | undefined,
  baseURL: string,
  now: number,
  ttlMs: number = MODEL_CATALOG_TTL_MS
): boolean {
  if (!cache || !Array.isArray(cache.models) || cache.models.length === 0) return false;
  if (normalizeModelBaseUrl(cache.baseURL) !== normalizeModelBaseUrl(baseURL)) return false;
  const age = now - cache.fetchedAt;
  return Number.isFinite(age) && age >= 0 && age < ttlMs;
}

// ---------------------------------------------------------------------------
// 组装 + 文案
// ---------------------------------------------------------------------------

/**
 * 组装最终下拉列表。
 *
 * 不变式（测试钉住）：
 *  ① 列表永不为空 —— 至少给 DEFAULT_MODEL_ID，避免"空下拉 + 空提交"把配置改坏；
 *  ② 当前配置值只要非空就一定在列表里（不在就追加为 `current` 项并标注）；
 *  ③ 顺序稳定：在线/快照顺序在前，`current` 兜底项在最后。
 */
export function buildModelCatalog(input: {
  current?: string;
  /** 来自在线（或在线缓存）的 id 列表；空/未传则用内置快照 */
  live?: string[];
  meta: ModelCatalogMeta;
}): ModelCatalog {
  const liveIds = (input.live ?? []).filter((id) => typeof id === 'string' && id.trim() !== '');
  const useLive = liveIds.length > 0;
  const sourceIds = useLive ? liveIds : BUILTIN_DEEPSEEK_MODELS.map((m) => m.id);

  const models: ModelOption[] = [];
  const seen = new Set<string>();
  for (const rawId of sourceIds) {
    const id = rawId.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      // 在线拉回来的 id 若在内置表里认识，就沿用那条更友好的文案
      label: builtinLabelOf(id) ?? id,
      source: useLive ? 'live' : 'builtin',
    });
  }

  const current = (input.current ?? '').trim();
  if (current && !seen.has(current)) {
    models.push({ id: current, label: `${current}（当前配置，不在已知列表中）`, source: 'current' });
    seen.add(current);
  }

  if (models.length === 0) {
    models.push({ id: DEFAULT_MODEL_ID, label: DEFAULT_MODEL_ID, source: 'builtin' });
  }

  return { models, hint: describeModelCatalog(input.meta, models, current) };
}

function builtinLabelOf(id: string): string | undefined {
  return BUILTIN_DEEPSEEK_MODELS.find((m) => m.id === id)?.label;
}

/** 失败原因 → 人话（文案唯一出口；不含任何凭据信息）。 */
export function describeFetchFailure(failure: ModelFetchFailure, detail?: string): string {
  const base = FAILURE_TEXT[failure];
  return detail ? `${base}（${detail}）` : base;
}

const FAILURE_TEXT: Record<ModelFetchFailure, string> = {
  'no-key': '未配置 API Key',
  unauthorized: 'API Key 无效或无权限',
  forbidden: 'API Key 无权访问该端点',
  'not-found': '端点未提供模型列表接口',
  http: '接口返回异常',
  network: '网络不可达（离线或代理拦截）',
  timeout: '请求超时',
  'bad-payload': '返回内容不是模型列表',
};

function describeModelCatalog(meta: ModelCatalogMeta, models: ModelOption[], current: string): string {
  const count = models.length;
  let head: string;
  if (meta.source === 'live') head = `已从 ${meta.endpointHost} 在线更新模型列表（${count} 个可选）`;
  else if (meta.source === 'cache') head = `模型列表来自 ${meta.endpointHost} 的在线缓存（${count} 个可选）`;
  else if (meta.failure) {
    head = `未能获取在线模型列表：${describeFetchFailure(meta.failure, meta.failureDetail)}；用内置快照（${BUILTIN_AS_OF}）`;
  } else head = `内置快照（${BUILTIN_AS_OF}）`;

  const preserved = current && models.some((m) => m.source === 'current') ? `；已保留当前配置的 ${current}` : '';
  return head + preserved;
}
