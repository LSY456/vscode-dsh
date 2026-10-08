import { describe, expect, it } from 'vitest';
import { API_KEY_SECRET, ConfigAccessor, ConfigSectionLike, SecretStore } from './configAccessor';
import { DEFAULT_MAX_CONTEXT_TOKENS, DEFAULT_MAX_TOOL_ROUNDS } from '../shared/protocol';

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
      maxToolRounds: DEFAULT_MAX_TOOL_ROUNDS,
      maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
      // 采样参数没有缺省值可回落到"当前值"：null = 用户没配过（详见下方「采样参数」一组）
      temperature: null,
      maxTokens: null,
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

describe('ConfigAccessor：Agent 预算（此前的"死配置"——用户改不到）', () => {
  it('未配置时回落到协议共享的缺省值（扩展与 daemon 不再各写一份）', () => {
    const cfg = new ConfigAccessor(makeSecrets().secrets, makeConfig().config).getPanelConfig();
    expect(cfg.maxToolRounds).toBe(DEFAULT_MAX_TOOL_ROUNDS);
    expect(cfg.maxContextTokens).toBe(DEFAULT_MAX_CONTEXT_TOKENS);
  });

  it('已配置时原样读出（用户显式设过的值不被缺省覆盖）', () => {
    const cfg = new ConfigAccessor(
      makeSecrets().secrets,
      makeConfig({ 'agent.maxToolRounds': 12, 'agent.maxContextTokens': 128_000 }).config
    ).getPanelConfig();
    expect(cfg.maxToolRounds).toBe(12);
    expect(cfg.maxContextTokens).toBe(128_000);
  });

  it('写入侧钳制：面板输入可被绕过，越界值不能进配置', async () => {
    const { config, map } = makeConfig();
    const acc = new ConfigAccessor(makeSecrets().secrets, config);

    await acc.applyPanelConfig({ maxToolRounds: 999, maxContextTokens: 1 });
    expect(map.get('agent.maxToolRounds')).toBe(50);
    expect(map.get('agent.maxContextTokens')).toBe(4_000);

    await acc.applyPanelConfig({ maxToolRounds: -3, maxContextTokens: 10 ** 9 });
    expect(map.get('agent.maxToolRounds')).toBe(1);
    expect(map.get('agent.maxContextTokens')).toBe(1_000_000);
  });

  it('非数字回落到缺省，绝不写进 0（0 会让上下文预算当场失效）', async () => {
    const { config, map } = makeConfig();
    const acc = new ConfigAccessor(makeSecrets().secrets, config);
    await acc.applyPanelConfig({
      maxToolRounds: Number.NaN,
      maxContextTokens: Number.POSITIVE_INFINITY,
    });
    expect(map.get('agent.maxToolRounds')).toBe(DEFAULT_MAX_TOOL_ROUNDS);
    expect(map.get('agent.maxContextTokens')).toBe(DEFAULT_MAX_CONTEXT_TOKENS);
  });

  it('未提交的字段不写（留空 = 不修改）', async () => {
    const { config, updates } = makeConfig();
    const acc = new ConfigAccessor(makeSecrets().secrets, config);
    await acc.applyPanelConfig({ model: 'deepseek-flash' });
    expect(updates.some(([k]) => k.startsWith('agent.'))).toBe(false);
  });
});

describe('ConfigAccessor：采样参数（批次 2）', () => {
  it('未配置时读出 null —— 不能用缺省值冒充"用户配过"', () => {
    const cfg = new ConfigAccessor(makeSecrets().secrets, makeConfig().config).getPanelConfig();
    // null ⇒ 面板留空、daemon 不下发 ⇒ 温度仍走模型层缺省、上限仍不发送，
    // 与引入本项之前逐字节一致。若在这里回落成 0.2，Anthropic 链路会被顺带改变行为
    // （它此前根本不发送温度）—— 那是"加一个可配项"不该带来的变化。
    expect(cfg.temperature).toBeNull();
    expect(cfg.maxTokens).toBeNull();
  });

  it('配置后原样读出，不被缺省或面板逻辑改写', () => {
    const cfg = new ConfigAccessor(
      makeSecrets().secrets,
      makeConfig({ 'model.temperature': 0.7, 'model.maxTokens': 8192 }).config
    ).getPanelConfig();
    expect(cfg.temperature).toBe(0.7);
    expect(cfg.maxTokens).toBe(8192);
  });

  it('写入侧钳制区间，且温度保留小数（走整数钳制会把 0.2 变成 0）', async () => {
    const { config, map } = makeConfig();
    const acc = new ConfigAccessor(makeSecrets().secrets, config);

    await acc.applyPanelConfig({ temperature: 0.2, maxTokens: 10 ** 9 });
    expect(map.get('model.temperature')).toBe(0.2);
    expect(map.get('model.maxTokens')).toBe(131_072);

    await acc.applyPanelConfig({ temperature: 9, maxTokens: -5 });
    expect(map.get('model.temperature')).toBe(2);
    expect(map.get('model.maxTokens')).toBe(1);
  });

  it('非数字丢弃本次写入，而不是落一个缺省值进去', async () => {
    const { config, map, updates } = makeConfig();
    const acc = new ConfigAccessor(makeSecrets().secrets, config);
    await acc.applyPanelConfig({ temperature: Number.NaN, maxTokens: Number.NaN });
    // 用户没填 ≠ 他想改成缺省值：写进去就等于替他做了决定
    expect(map.has('model.temperature')).toBe(false);
    expect(map.has('model.maxTokens')).toBe(false);
    expect(updates).toHaveLength(0);
  });
});