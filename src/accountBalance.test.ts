/**
 * 账户余额模块的单测（纯函数 + 注入式 fetch，不出网）。
 *
 * 钉住的产品判断：
 *  - 拿不到余额时**显示"不适用"而不是 0**（0 余额是个很重的结论，不能靠默认值给出）；
 *  - 金额原样透出，不做数值换算；
 *  - 失败原因可读且**不含凭据**；
 *  - 只有 404 才换候选路径（401/403 换路径是同一个结果）。
 */
import { describe, expect, it } from 'vitest';
import {
  BALANCE_TTL_MS,
  type BalanceFetchLike,
  type ModelListResponseLike,
  balanceEndpointCandidates,
  buildBalancePayload,
  describeBalanceTitle,
  fetchBalance,
  formatBalanceText,
  insufficientBalance,
  parseBalance,
} from './accountBalance';

const OFFICIAL = {
  is_available: true,
  balance_infos: [
    { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' },
  ],
};

function jsonResponse(status: number, body: unknown): ModelListResponseLike {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe('解析余额响应', () => {
  it('按官方样例取到总额 / 赠金 / 充值 / 可用性', () => {
    expect(parseBalance(OFFICIAL)).toEqual({
      currency: 'CNY',
      total: '110.00',
      granted: '10.00',
      toppedUp: '100.00',
      isAvailable: true,
    });
  });

  it('缺 is_available 时不臆测"余额不足"', () => {
    const info = parseBalance({ balance_infos: [{ currency: 'USD', total_balance: '5' }] });
    expect(info?.isAvailable).toBe(true);
    expect(info?.granted).toBe('');
  });

  it('is_available=false 原样透出', () => {
    const info = parseBalance({ is_available: false, balance_infos: [{ total_balance: '0.00' }] });
    expect(info?.isAvailable).toBe(false);
  });

  it('跳过缺 total_balance 的条目，取第一条合法项', () => {
    const info = parseBalance({
      balance_infos: [{ currency: 'CNY' }, null, { currency: 'USD', total_balance: ' 5.00 ' }],
    });
    expect(info?.currency).toBe('USD');
    expect(info?.total).toBe('5.00');
  });

  it('形状不对时返回 undefined（交给调用方按"拿不到"处理）', () => {
    expect(parseBalance(null)).toBeUndefined();
    expect(parseBalance('nope')).toBeUndefined();
    expect(parseBalance({})).toBeUndefined();
    expect(parseBalance({ balance_infos: {} })).toBeUndefined();
    expect(parseBalance({ balance_infos: [{ total_balance: '   ' }] })).toBeUndefined();
  });
});

describe('端点推导', () => {
  it('base 带 /v1、/anthropic 时各追加一条去掉后缀的候选', () => {
    expect(balanceEndpointCandidates('')).toEqual([
      'https://api.deepseek.com/v1/user/balance',
      'https://api.deepseek.com/user/balance',
    ]);
    expect(balanceEndpointCandidates('https://api.deepseek.com/anthropic')).toEqual([
      'https://api.deepseek.com/anthropic/user/balance',
      'https://api.deepseek.com/user/balance',
    ]);
  });

  it('自定义网关不猜它的站点根', () => {
    expect(balanceEndpointCandidates('https://gw.local')).toEqual(['https://gw.local/user/balance']);
  });
});

describe('是否见底', () => {
  const base = { currency: 'CNY', granted: '', toppedUp: '', isAvailable: true };

  it('官方判定不可用 → 见底', () => {
    expect(insufficientBalance({ ...base, total: '110.00', isAvailable: false })).toBe(true);
  });

  it('总额为 0 → 见底', () => {
    expect(insufficientBalance({ ...base, total: '0.00' })).toBe(true);
    expect(insufficientBalance({ ...base, total: '0' })).toBe(true);
  });

  it('有余额 → 不见底；金额无法解析时也不臆测', () => {
    expect(insufficientBalance({ ...base, total: '0.01' })).toBe(false);
    expect(insufficientBalance({ ...base, total: '--' })).toBe(false);
  });
});

describe('展示文案', () => {
  const cny = { currency: 'CNY', total: '110.00', granted: '10.00', toppedUp: '100.00', isAvailable: true };

  it('金额原样透出，不换算不四舍五入；币种按符号（未知币种写代码）', () => {
    expect(formatBalanceText(cny)).toBe('余额 ¥110.00');
    expect(formatBalanceText({ ...cny, currency: 'USD', total: '5.00' })).toBe('余额 $5.00');
    expect(formatBalanceText({ ...cny, currency: 'EUR', total: '5.00' })).toBe('余额 5.00 EUR');
    expect(formatBalanceText({ ...cny, currency: '', total: '5.00' })).toBe('余额 5.00');
  });

  it('悬停提示给出明细、更新时间与刷新提示', () => {
    const title = describeBalanceTitle(cny, '22:50:01');
    expect(title).toContain('API 余额 ¥110.00');
    expect(title).toContain('赠金 10.00');
    expect(title).toContain('充值 100.00');
    expect(title).toContain('更新于 22:50:01');
    expect(title).toContain('点击刷新');
    expect(title).not.toContain('余额不足');
  });

  it('余额不足时在提示里说明后果（而不是只换个颜色）', () => {
    expect(describeBalanceTitle({ ...cny, total: '0.00' })).toContain('余额不足，API 调用可能失败');
  });

  it('文案不含凭据', () => {
    const text = describeBalanceTitle(cny, '22:50:01');
    expect(text).not.toMatch(/sk-|Bearer|Bearer\s|apiKey/i);
  });

  it('载荷：可用 + 不足标记由同一个出口给出', () => {
    expect(buildBalancePayload(cny)).toMatchObject({ available: true, text: '余额 ¥110.00', insufficient: false });
    expect(buildBalancePayload({ ...cny, total: '0.00' })).toMatchObject({ insufficient: true });
  });
});

describe('拉取余额', () => {
  it('200 时返回解析结果，并带上 Bearer 鉴权头', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fake: BalanceFetchLike = async (url, init) => {
      calls.push({ url, headers: init.headers });
      return jsonResponse(200, OFFICIAL);
    };

    const r = await fetchBalance({
      candidates: balanceEndpointCandidates(''),
      apiKey: 'sk-test',
      fetchImpl: fake,
    });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.info.total).toBe('110.00');
      expect(r.endpoint).toBe('https://api.deepseek.com/v1/user/balance');
    }
    expect(calls[0].headers.Authorization).toBe('Bearer sk-test');
    expect(BALANCE_TTL_MS).toBeGreaterThan(0);
  });

  it('404 换下一条候选；401 不换（换路径是同一个结果）', async () => {
    const urls: string[] = [];
    const flaky: BalanceFetchLike = async (url) => {
      urls.push(url);
      return url.endsWith('/v1/user/balance') ? jsonResponse(404, {}) : jsonResponse(200, OFFICIAL);
    };
    const okRes = await fetchBalance({
      candidates: balanceEndpointCandidates('https://api.deepseek.com/v1'),
      apiKey: 'k',
      fetchImpl: flaky,
    });
    expect(okRes.ok).toBe(true);
    expect(urls).toHaveLength(2);

    const urls2: string[] = [];
    const denied: BalanceFetchLike = async (url) => {
      urls2.push(url);
      return jsonResponse(401, {});
    };
    const r = await fetchBalance({
      candidates: balanceEndpointCandidates('https://api.deepseek.com/v1'),
      apiKey: 'bad',
      fetchImpl: denied,
    });
    expect(r).toEqual({ ok: false, detail: 'HTTP 401' });
    expect(urls2).toHaveLength(1);
  });

  it('超时 / 网络不可达 / 返回无法解析 各自给可读原因', async () => {
    const hang: BalanceFetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    expect(await fetchBalance({ candidates: ['https://gw/balance'], apiKey: 'k', timeoutMs: 10, fetchImpl: hang })).toEqual({
      ok: false,
      detail: '请求超时',
    });

    const boom: BalanceFetchLike = async () => {
      throw new Error('ENOTFOUND');
    };
    expect(await fetchBalance({ candidates: ['https://gw/balance'], apiKey: 'k', fetchImpl: boom })).toEqual({
      ok: false,
      detail: '网络不可达',
    });

    const brokenJson: ModelListResponseLike = {
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('bad json');
      },
    };
    expect(await fetchBalance({ candidates: ['https://gw/balance'], apiKey: 'k', fetchImpl: async () => brokenJson })).toEqual({
      ok: false,
      detail: '返回内容无法解析',
    });

    expect(
      await fetchBalance({
        candidates: ['https://gw/balance'],
        apiKey: 'k',
        fetchImpl: async () => jsonResponse(200, { hello: 'world' }),
      })
    ).toEqual({ ok: false, detail: '返回内容不含余额字段' });
  });
});
