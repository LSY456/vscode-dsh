/**
 * 账户余额（DeepSeek `GET /user/balance`）。
 *
 * 为什么要显示它：Agent 跑起来后"还剩多少钱"是使用者最关心、却最看不见的一件事 ——
 * 余额不足时报错来自上游（`is_available: false` / 402），那时已经晚了一步。
 * 所以把余额放进状态行（模型名同一行），让它像 IDE 状态栏一样常驻可见。
 *
 * 官方接口（https://api-docs.deepseek.com/api/get-user-balance ）：
 *   GET https://api.deepseek.com/user/balance   （Bearer 鉴权）
 *   → { is_available: boolean, balance_infos: [{ currency, total_balance,
 *       granted_balance, topped_up_balance }] }   ← 金额都是**字符串**
 *
 * 几条刻意的约束：
 *  - **只在 DeepSeek 官方端点上取**。`/user/balance` 是 DeepSeek 的账户级接口：
 *    用户自配的第三方网关未必有它，而为了"锦上添花的展示"把 API Key 送到第三方去也不合适 ——
 *    非官方端点直接视为"不适用"，不产生必然的 404。
 *  - 金额**原样透出**，不做数值换算/四舍五入（上游是权威；换币种也不猜汇率）。
 *  - 余额是"最近一次已知值"：刷新失败时**保留旧值**（只记日志），不把界面清空 ——
 *    一次网络抖动就显示"没有余额"比显示一个稍旧的数字更误导。
 *  - 本模块的纯函数部分（解析/格式化/端点）可单测；发请求部分用注入的 fetch，
 *    单测不出网。
 */
import { endpointHostOf, isOfficialDeepSeekEndpoint, normalizeModelBaseUrl } from './modelCatalog';

/** 余额取数超时：比模型列表更舍得等（它可能被用户盯着看），但仍要能失败。 */
export const BALANCE_FETCH_TIMEOUT_MS = 6000;

/** 余额缓存 TTL：状态行上的数字不必秒级新鲜，但也不能停在半小时前。 */
export const BALANCE_TTL_MS = 60 * 1000;

export interface BalanceInfo {
  /** 币种，原样透出（官方为 CNY / USD；未知币种不做假设） */
  currency: string;
  /** 总可用余额（= 赠金 + 充值），字符串原样保留 */
  total: string;
  granted: string;
  toppedUp: string;
  /** 官方判定"余额是否够调用"。缺字段时按 true 处理：不臆测不足 */
  isAvailable: boolean;
}

/** 推给 webview 的载荷（webview 只负责渲染，文案在扩展侧组装）。 */
export interface BalancePayload {
  /** false = 不适用/未知 → 界面隐藏该 chip（而不是显示 0 或 "--"） */
  available: boolean;
  /** 紧凑文案，如 `余额 ¥110.00` */
  text?: string;
  /** 悬停提示：明细 + 更新时间 + 刷新提示 */
  title?: string;
  /** 余额不足（官方 is_available=false 或总额为 0）→ 界面用警示色 */
  insufficient?: boolean;
}

export interface ModelListResponseLike {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

export type BalanceFetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal }
) => Promise<ModelListResponseLike>;

export type BalanceFetchResult =
  | { ok: true; info: BalanceInfo; endpoint?: string }
  | { ok: false; detail: string };

/** 币种符号。未知币种不加符号（写清币种代码更有用）。 */
const CURRENCY_SYMBOL: Record<string, string> = { CNY: '¥', USD: '$' };

/** 候选端点：官方文档写 `${base}/user/balance`；base 带 `/v1`、`/anthropic` 时再试去掉后缀的那条。 */
export function balanceEndpointCandidates(baseURL?: string): string[] {
  const base = normalizeModelBaseUrl(baseURL);
  const out = [`${base}/user/balance`];
  const stripped = base.replace(/\/(?:v1|anthropic)$/i, '');
  if (stripped !== base) out.push(`${stripped}/user/balance`);
  return out;
}

/**
 * 解析 `/user/balance` 响应。
 * 条目不合法（缺 total_balance）时返回 undefined —— 由调用方按"拿不到"处理，
 * 而不是显示一个凭空的 0（0 余额是个很重的结论，不能靠默认值给出）。
 */
export function parseBalance(payload: unknown): BalanceInfo | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const obj = payload as { is_available?: unknown; balance_infos?: unknown };
  const infos = Array.isArray(obj.balance_infos) ? obj.balance_infos : [];
  for (const raw of infos) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const total = typeof entry.total_balance === 'string' ? entry.total_balance.trim() : '';
    if (!total) continue;
    return {
      currency: typeof entry.currency === 'string' ? entry.currency.trim() : '',
      total,
      granted: typeof entry.granted_balance === 'string' ? entry.granted_balance.trim() : '',
      toppedUp: typeof entry.topped_up_balance === 'string' ? entry.topped_up_balance.trim() : '',
      // 缺 is_available 时不臆测"余额不足"
      isAvailable: obj.is_available !== false,
    };
  }
  return undefined;
}

/** 金额数字解析（只在判断"是否见底"时用；展示一律用原字符串）。 */
function amountOf(value: string): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** 余额是否见底：官方说不可用，或总额确实为 0。 */
export function insufficientBalance(info: BalanceInfo): boolean {
  if (!info.isAvailable) return true;
  const n = amountOf(info.total);
  return n !== undefined && n <= 0;
}

/** 紧凑文案：`余额 ¥110.00`（状态行只有一行，字要省；明细放 title）。 */
export function formatBalanceText(info: BalanceInfo): string {
  const symbol = CURRENCY_SYMBOL[info.currency] ?? '';
  const amount = symbol ? `${symbol}${info.total}` : `${info.total}${info.currency ? ' ' + info.currency : ''}`;
  return `余额 ${amount}`;
}

/** 悬停提示：明细 + 更新时间 + 操作提示（文案唯一出口）。 */
export function describeBalanceTitle(info: BalanceInfo, updatedAtText?: string): string {
  const parts = [`API 余额 ${formatBalanceText(info).replace(/^余额 /, '')}`];
  if (info.granted || info.toppedUp) {
    const detail: string[] = [];
    if (info.granted) detail.push(`赠金 ${info.granted}`);
    if (info.toppedUp) detail.push(`充值 ${info.toppedUp}`);
    parts.push(detail.join(' · '));
  }
  if (insufficientBalance(info)) parts.push('余额不足，API 调用可能失败');
  if (updatedAtText) parts.push(`更新于 ${updatedAtText}`);
  parts.push('点击刷新');
  return parts.join('｜');
}

/** 组装给 webview 的载荷（唯一出口：webview 不拼文案、不做币种判断）。 */
export function buildBalancePayload(info: BalanceInfo, updatedAtText?: string): BalancePayload {
  return {
    available: true,
    text: formatBalanceText(info),
    title: describeBalanceTitle(info, updatedAtText),
    insufficient: insufficientBalance(info),
  };
}

export interface FetchBalanceOptions {
  candidates: string[];
  apiKey: string;
  timeoutMs?: number;
  fetchImpl?: BalanceFetchLike;
}

/** 拉一次余额。失败一律返回可读 detail（进日志；**永不包含凭据**）。 */
export async function fetchBalance(opts: FetchBalanceOptions): Promise<BalanceFetchResult> {
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : BALANCE_FETCH_TIMEOUT_MS;
  const doFetch = opts.fetchImpl ?? (globalThis.fetch as unknown as BalanceFetchLike | undefined);
  if (typeof doFetch !== 'function') return { ok: false, detail: '当前运行环境无 fetch' };

  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Bearer ${opts.apiKey}`,
  };

  let last: BalanceFetchResult = { ok: false, detail: '网络不可达' };
  for (const url of opts.candidates) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: ModelListResponseLike;
    try {
      res = await doFetch(url, { headers, signal: controller.signal });
    } catch (err) {
      const name = (err as { name?: unknown } | null)?.name;
      last = { ok: false, detail: name === 'AbortError' || name === 'TimeoutError' ? '请求超时' : '网络不可达' };
      continue;
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      last = { ok: false, detail: `HTTP ${res.status}` };
      // 只有 404 值得换候选路径（/v1 与不带 /v1 两条都可能有效）；
      // 401/403 换路径是同一个结果，重试只会拖慢并掩盖真因。
      if (res.status !== 404) return last;
      continue;
    }

    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      return { ok: false, detail: '返回内容无法解析' };
    }
    const info = parseBalance(payload);
    if (!info) return { ok: false, detail: '返回内容不含余额字段' };
    return { ok: true, info, endpoint: url };
  }
  return last;
}

/** 端点 host（日志用；拿不到就原样返回）。 */
export function describeBalanceEndpoint(url: string): string {
  return endpointHostOf(url);
}
