/**
 * 模型目录（下拉数据源）的单测。
 *
 * 重点钉住的不是"实现细节"，而是几条**不能退让的产品不变式**：
 *  ① 内置快照绝不包含已弃用的模型名（否则等于继续引导用户踩坑）；
 *  ② 组装出的下拉永不为空 —— 空下拉会把一次误点变成"配置被清空"；
 *  ③ 当前配置值永远保留在列表里 —— 绝不因"不在列表里"而静默改用户的配置。
 */
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_AS_OF,
  BUILTIN_DEEPSEEK_MODELS,
  DEFAULT_MODEL_BASE_URL,
  DEFAULT_MODEL_ID,
  MODEL_CATALOG_TTL_MS,
  type ModelCatalogMeta,
  buildModelCatalog,
  describeFetchFailure,
  endpointHostOf,
  isModelCatalogCacheFresh,
  isOfficialDeepSeekEndpoint,
  modelEndpointCandidates,
  normalizeModelBaseUrl,
  parseModelIds,
  shouldAttemptModelFetch,
} from './modelCatalog';

const meta = (over: Partial<ModelCatalogMeta> = {}): ModelCatalogMeta => ({
  source: 'builtin',
  endpointHost: 'api.deepseek.com',
  hasApiKey: true,
  ...over,
});

describe('内置快照', () => {
  it('不含已弃用的模型名，且缺省模型名取自官方现行列表', () => {
    const ids = BUILTIN_DEEPSEEK_MODELS.map((m) => m.id);
    // 2026/07/24 弃用：列进去就是继续引导用户选一个必然报错的名字
    expect(ids).not.toContain('deepseek-chat');
    expect(ids).not.toContain('deepseek-reasoner');
    expect(ids).toContain('deepseek-flash');
    expect(ids).toContain('deepseek-v4-pro');
    expect(ids).toContain(DEFAULT_MODEL_ID);
  });

  it('快照标注取材日期，供 UI 说明"这不是实时列表"', () => {
    expect(BUILTIN_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('端点推导', () => {
  it('空 base 回落缺省端点，末尾斜杠被归一化', () => {
    expect(normalizeModelBaseUrl('')).toBe(DEFAULT_MODEL_BASE_URL);
    expect(normalizeModelBaseUrl('   ')).toBe(DEFAULT_MODEL_BASE_URL);
    expect(normalizeModelBaseUrl('https://api.deepseek.com/v1///')).toBe('https://api.deepseek.com/v1');
  });

  it('官方端点判定按 host，空值（=用缺省端点）也算官方', () => {
    expect(isOfficialDeepSeekEndpoint('')).toBe(true);
    expect(isOfficialDeepSeekEndpoint('https://api.deepseek.com/v1')).toBe(true);
    expect(isOfficialDeepSeekEndpoint('https://API.DeepSeek.com')).toBe(true);
    expect(isOfficialDeepSeekEndpoint('https://my.gateway.local/v1')).toBe(false);
    expect(isOfficialDeepSeekEndpoint('https://api.deepseek.com.evil.example/v1')).toBe(false);
    expect(isOfficialDeepSeekEndpoint('not a url')).toBe(false);
  });

  it('/v1、/anthropic 后缀各追加一条候选（官方两条路径都记作可用）', () => {
    expect(modelEndpointCandidates('')).toEqual([
      'https://api.deepseek.com/v1/models',
      'https://api.deepseek.com/models',
    ]);
    expect(modelEndpointCandidates('https://api.deepseek.com/anthropic')).toEqual([
      'https://api.deepseek.com/anthropic/models',
      'https://api.deepseek.com/models',
    ]);
  });

  it('自定义网关不猜它的站点根（只保留一条候选）', () => {
    expect(modelEndpointCandidates('https://my.gateway.local')).toEqual([
      'https://my.gateway.local/models',
    ]);
  });

  it('host 解析失败时原样返回，便于排障时看到原始串', () => {
    expect(endpointHostOf('https://api.deepseek.com/v1/models')).toBe('api.deepseek.com');
    expect(endpointHostOf('garbage')).toBe('garbage');
  });
});

describe('响应解析', () => {
  it('按 OpenAI 规范取 data[].id，去空白去重保序', () => {
    expect(
      parseModelIds({
        object: 'list',
        data: [
          { id: 'deepseek-flash', object: 'model', owned_by: 'deepseek' },
          { id: ' deepseek-v4-pro ' },
          { id: 'deepseek-flash' },
        ],
      })
    ).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
  });

  it('兼容 data 为字符串数组 / models 字段 / 裸数组', () => {
    expect(parseModelIds({ data: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(parseModelIds({ models: [{ id: 'm1' }] })).toEqual(['m1']);
    expect(parseModelIds(['x', 'y'])).toEqual(['x', 'y']);
  });

  it('形状不对时返回空数组（交给上层判定 bad-payload）', () => {
    expect(parseModelIds(null)).toEqual([]);
    expect(parseModelIds({})).toEqual([]);
    expect(parseModelIds({ data: {} })).toEqual([]);
    expect(parseModelIds({ data: [{ name: 'x' }, 1, null, '', '  '] })).toEqual([]);
  });
});

describe('是否值得发一次在线请求', () => {
  it('官方端点 + 无 Key → 不发（必然是 401，白等一次超时）', () => {
    expect(shouldAttemptModelFetch({ hasApiKey: false, officialBase: true })).toBe(false);
  });

  it('自定义端点即使无 Key 也发（本地 Ollama / 内网网关常允许匿名 /models）', () => {
    expect(shouldAttemptModelFetch({ hasApiKey: false, officialBase: false })).toBe(true);
    expect(shouldAttemptModelFetch({ hasApiKey: true, officialBase: true })).toBe(true);
  });
});

describe('在线缓存新鲜度', () => {
  const now = 1_700_000_000_000;
  const cache = { baseURL: 'https://api.deepseek.com/v1', fetchedAt: now - 1000, models: ['deepseek-flash'] };

  it('TTL 内且同一 base → 命中', () => {
    expect(isModelCatalogCacheFresh(cache, 'https://api.deepseek.com/v1', now)).toBe(true);
  });

  it('过期 / 换过 base / 空列表 / 无缓存 → 未命中', () => {
    expect(isModelCatalogCacheFresh(cache, cache.baseURL, now + MODEL_CATALOG_TTL_MS)).toBe(false);
    expect(isModelCatalogCacheFresh(cache, 'https://other.gw/v1', now)).toBe(false);
    expect(isModelCatalogCacheFresh({ ...cache, models: [] }, cache.baseURL, now)).toBe(false);
    expect(isModelCatalogCacheFresh(undefined, cache.baseURL, now)).toBe(false);
  });
});

describe('组装下拉列表', () => {
  it('有在线列表时以它为准，且认识的 id 复用内置的友好文案', () => {
    const { models } = buildModelCatalog({
      current: '',
      live: ['deepseek-flash', 'deepseek-v4-pro'],
      meta: meta({ source: 'live' }),
    });
    expect(models.map((m) => m.id)).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
    expect(models[0].label).toBe('deepseek-flash（快速 · 1M）');
    expect(models.every((m) => m.source === 'live')).toBe(true);
  });

  it('在线列表里不认识的 id 原样展示（第三方网关也能用）', () => {
    const { models } = buildModelCatalog({
      current: '',
      live: ['deepseek-flash', 'my-finetune-v2'],
      meta: meta({ source: 'live' }),
    });
    expect(models[1]).toEqual({ id: 'my-finetune-v2', label: 'my-finetune-v2', source: 'live' });
  });

  it('无在线列表时用内置快照', () => {
    const { models } = buildModelCatalog({ current: '', meta: meta() });
    expect(models.map((m) => m.id)).toEqual(BUILTIN_DEEPSEEK_MODELS.map((m) => m.id));
    expect(models.every((m) => m.source === 'builtin')).toBe(true);
  });

  it('空/脏在线列表一律回落内置快照（不产生空下拉）', () => {
    for (const live of [[], ['', '   ']]) {
      const { models } = buildModelCatalog({ current: '', live, meta: meta({ source: 'live' }) });
      expect(models.length).toBeGreaterThan(0);
      expect(models[0].id).toBe('deepseek-flash');
    }
  });

  it('当前配置不在列表里 → 追加为可选项并标注，绝不静默改配置', () => {
    const { models, hint } = buildModelCatalog({
      current: 'deepseek-chat',
      live: ['deepseek-flash'],
      meta: meta({ source: 'live' }),
    });
    expect(models.map((m) => m.id)).toEqual(['deepseek-flash', 'deepseek-chat']);
    expect(models[1].source).toBe('current');
    expect(models[1].label).toContain('当前配置');
    expect(hint).toContain('已保留当前配置的 deepseek-chat');
  });

  it('当前配置已在列表里时不重复追加', () => {
    const { models, hint } = buildModelCatalog({
      current: 'deepseek-flash',
      live: ['deepseek-flash'],
      meta: meta({ source: 'live' }),
    });
    expect(models.length).toBe(1);
    expect(hint).not.toContain('已保留');
  });

  it('列表永不为空：没配过模型、也没有在线列表时，第一项就是缺省模型', () => {
    // 这是"从未配置过模型"的首次安装路径：列表必须自带一个可用值，
    // 否则用户会看到一个空下拉，而空值提交上去就是一次无效请求。
    const { models } = buildModelCatalog({ current: '', live: [], meta: meta() });
    expect(models.length).toBeGreaterThan(0);
    expect(models[0].id).toBe(DEFAULT_MODEL_ID);
    expect(models.every((m) => m.id !== '')).toBe(true);
  });
});

describe('来源提示文案', () => {
  it('在线 / 缓存 / 快照三种来源各自说清数据从哪来', () => {
    const live = buildModelCatalog({ live: ['a'], meta: meta({ source: 'live', endpointHost: 'api.deepseek.com' }) });
    expect(live.hint).toContain('已从 api.deepseek.com 在线更新');

    const cached = buildModelCatalog({ live: ['a'], meta: meta({ source: 'cache' }) });
    expect(cached.hint).toContain('在线缓存');

    const builtin = buildModelCatalog({ meta: meta({ source: 'builtin', hasApiKey: false, failure: 'no-key' }) });
    expect(builtin.hint).toContain('未能获取在线模型列表：未配置 API Key');
    expect(builtin.hint).toContain(BUILTIN_AS_OF);
  });

  it('失败原因按状态码给确定说法，并附上细节', () => {
    expect(describeFetchFailure('unauthorized', 'HTTP 401')).toBe('API Key 无效或无权限（HTTP 401）');
    expect(describeFetchFailure('not-found')).toBe('端点未提供模型列表接口');
    expect(describeFetchFailure('timeout')).toContain('超时');
    // 不做"请检查配置"这类不区分的猜测式提示
    expect(describeFetchFailure('unauthorized')).not.toContain('检查');
  });

  it('失败文案不泄露凭据（只允许状态码这类信息）', () => {
    const hint = buildModelCatalog({
      meta: meta({ source: 'builtin', failure: 'unauthorized', failureDetail: 'HTTP 401' }),
    }).hint;
    expect(hint).not.toMatch(/sk-|Bearer|apiKey/i);
  });
});
