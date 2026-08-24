import { describe, expect, it } from 'vitest';
import { API_KEY_SECRET, ConfigAccessor, ConfigSectionLike, SecretStore } from './configAccessor';

/** 内存假体：可记录调用轨迹（验证「只迁移一次」等真实行为）。 */
function makeSecrets(init: Record<string, string> = {}) {
  const map = new Map(Object.entries(init));
  const storeCalls: string[] = [];
  const deleteCalls: string[] = [];
  const secrets: SecretStore = {
    get: async (k) => map.get(k),
    store: async (k, v) => {
      map.set(k, v);
      storeCalls.push(k);
    },
    delete: async (k) => {
      map.delete(k);
      deleteCalls.push(k);
    },
  };
  return { secrets, map, storeCalls, deleteCalls };
}

function makeConfig(init: Record<string, unknown> = {}) {
  const map = new Map(Object.entries(init));
  const updates: Array<[string, unknown]> = [];
  const config: ConfigSectionLike = {
    get: <T,>(key: string, def: T): T => (map.has(key) ? (map.get(key) as T) : def),
    update: async (key, value) => {
      updates.push([key, value]);
      if (value === undefined) map.delete(key);
      else map.set(key, value);
    },
  };
  return { config, map, updates };
}

describe('ConfigAccessor：apiKey 读取与迁移（安全边界）', () => {
  it('SecretStorage 有值：直接返回，不触碰 settings 明文', async () => {
    const { secrets } = makeSecrets({ [API_KEY_SECRET]: 'sk-secret' });
    const { config, map } = makeConfig({ apiKey: 'sk-legacy' });
    const acc = new ConfigAccessor(secrets, config);

    expect(await acc.getApiKey()).toBe('sk-secret');
    // 明文项未被读取清除（迁移未触发）
    expect(map.has('apiKey')).toBe(true);
  });

  it('仅旧明文：回迁到 SecretStorage 并清除 settings 明文，迁移恰好一次', async () => {
    const { secrets, map: secMap, storeCalls } = makeSecrets();
    const { config, map: cfgMap, updates } = makeConfig({ apiKey: 'sk-legacy' });
    const acc = new ConfigAccessor(secrets, config);

    expect(await acc.getApiKey()).toBe('sk-legacy');
    expect(secMap.get(API_KEY_SECRET)).toBe('sk-legacy'); // 已回迁
    expect(cfgMap.has('apiKey')).toBe(false); // 明文已清
    expect(updates).toContainEqual(['apiKey', undefined]);

    // 再次读取：走 SecretStorage，不再重复写入/再次触发迁移
    expect(await acc.getApiKey()).toBe('sk-legacy');
    expect(storeCalls).toHaveLength(1);
  });

  it('都没有：返回空串', async () => {
    const acc = new ConfigAccessor(makeSecrets().secrets, makeConfig().config);
    expect(await acc.getApiKey()).toBe('');
    expect(await acc.hasApiKey()).toBe(false);
  });
});

describe('ConfigAccessor：apiKey 写入（只写 SecretStorage）', () => {
  it('非空写入 SecretStorage，绝不留 settings 明文', async () => {
    const { secrets, map } = makeSecrets();
    const { config, updates } = makeConfig();
    const acc = new ConfigAccessor(secrets, config);

    await acc.setApiKey('sk-new');
    expect(map.get(API_KEY_SECRET)).toBe('sk-new');
    expect(updates).toHaveLength(0); // config 未写入任何明文
  });

  it('空串 = 清除 SecretStorage', async () => {
    const { secrets, map, deleteCalls } = makeSecrets({ [API_KEY_SECRET]: 'sk-x' });
    const acc = new ConfigAccessor(secrets, makeConfig().config);
    await acc.setApiKey('');
    expect(map.has(API_KEY_SECRET)).toBe(false);
    expect(deleteCalls).toEqual([API_KEY_SECRET]);
    expect(await acc.hasApiKey()).toBe(false);
  });
});

describe('ConfigAccessor：面板配置读写（非凭据项）', () => {
  it('getPanelConfig 读取当前值并带默认', () => {
    const acc = new ConfigAccessor(
      makeSecrets().secrets,
      makeConfig({ 'model.baseURL': 'https://api.deepseek.com/v1', preset: 'coder' }).config
    );
    expect(acc.getPanelConfig()).toEqual({
      baseURL: 'https://api.deepseek.com/v1',
      model: '',
      preset: 'coder',
      provider: 'auto',
    });
  });

  it('applyPanelConfig 写回普通配置项', async () => {
    const { config, map, updates } = makeConfig();
    const acc = new ConfigAccessor(makeSecrets().secrets, config);
    await acc.applyPanelConfig({
      model: 'deepseek-reasoner',
      baseURL: 'https://x/v1',
      preset: 'default',
      provider: 'anthropic',
    });
    expect(map.get('model.model')).toBe('deepseek-reasoner');
    expect(map.get('model.baseURL')).toBe('https://x/v1');
    expect(map.get('preset')).toBe('default');
    expect(map.get('model.provider')).toBe('anthropic');
    // 只写普通项，apiKey 走 SecretStorage 单独入口
    expect(updates.some(([k]) => k === 'apiKey')).toBe(false);
  });
});