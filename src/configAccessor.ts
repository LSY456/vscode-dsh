/**
 * 配置存取（A4：apiKey 安全化 + 配置面板数据源）。
 *
 * 安全诉求（真实场景）：`dsh.apiKey` 若长期明文存放在 settings.json，
 * 可能随配置同步/备份泄露。企业级做法是把凭据放入 VSCode SecretStorage
 * （OS 级加密存储；Linux 依赖 keyring，拿不到时返回空并由 UI 提示）。
 *
 * 迁移策略（兼容老用户）：
 *  - 读 key 时 SecretStorage 优先；为空才回退 settings.json 旧明文 `dsh.apiKey`，
 *    一旦读到旧明文立即回迁写入 SecretStorage 并清除配置中的明文项；
 *  - 写 key 只写 SecretStorage，绝不落盘到 settings.json。
 *
 * 依赖（SecretStore / ConfigSectionLike）以接口注入，便于用内存假体做
 * 确定性测试，不依赖 vscode 运行时。
 */
import { DEFAULT_MAX_CONTEXT_TOKENS, DEFAULT_MAX_TOOL_ROUNDS } from '../shared/protocol';

/** 采样参数的可配置区间（写入侧收敛用；与 package.json 的 minimum/maximum 一致）。 */
const TEMPERATURE_RANGE = { min: 0, max: 2 } as const;
const MAX_OUTPUT_TOKENS_RANGE = { min: 1, max: 131_072 } as const;

export const API_KEY_SECRET = 'dsh.apiKey';

/** 用 PromiseLike 而非 Promise：兼容 vscode.Thenable 返回值 */
export interface SecretStore {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

/** workspace.getConfiguration('dsh') 的收敛子集 */
export interface ConfigSectionLike {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): PromiseLike<void>;
}

export class ConfigAccessor {
  constructor(
    private readonly secrets: SecretStore,
    private readonly config: ConfigSectionLike
  ) {}

  /** 是否已配置 apiKey（面板 UI 用，不泄露 key 本身）。 */
  async hasApiKey(): Promise<boolean> {
    return !!(await this.getApiKey());
  }

  /**
   * 读取 apiKey：SecretStorage 优先；无则回迁旧明文并清除（一次性迁移副作用）。
   * 返回空串表示未配置。
   */
  async getApiKey(): Promise<string> {
    const fromSecrets = await this.secrets.get(API_KEY_SECRET);
    if (fromSecrets) return fromSecrets;

    const legacy = this.config.get<string>('apiKey', '');
    if (legacy) {
      // 旧明文回迁后立即清除，避免凭据继续躺在 settings.json
      await this.secrets.store(API_KEY_SECRET, legacy);
      await this.config.update('apiKey', undefined);
      return legacy;
    }
    return '';
  }

  /** 设置 apiKey（仅写 SecretStorage）。空串 = 清除。 */
  async setApiKey(key: string): Promise<void> {
    if (key) await this.secrets.store(API_KEY_SECRET, key);
    else await this.secrets.delete(API_KEY_SECRET);
  }

  /** 面板可编辑的普通配置项（不含凭据项）。 */
  getPanelConfig(): {
    baseURL: string;
    model: string;
    preset: string;
    provider: string;
    maxToolRounds: number;
    maxContextTokens: number;
    temperature: number | null;
    maxTokens: number | null;
  } {
    return {
      baseURL: this.config.get('model.baseURL', ''),
      model: this.config.get('model.model', ''),
      preset: this.config.get('preset', 'default'),
      provider: this.config.get('model.provider', 'auto'),
      // Agent 循环预算：此前只有 daemon 侧读得到、扩展从不下发，用户改不到（死配置）。
      // 缺省值与协议共用，避免两侧各写一份而漂移。
      maxToolRounds: this.config.get('agent.maxToolRounds', DEFAULT_MAX_TOOL_ROUNDS),
      maxContextTokens: this.config.get('agent.maxContextTokens', DEFAULT_MAX_CONTEXT_TOKENS),
      // 采样参数刻意**不给缺省值**：null 表示"用户没配" —— 面板留空、daemon 侧不下发，
      // 于是温度仍走模型层缺省（0.2）、上限仍不发送，与引入本项之前逐字节一致。
      // 若在这里回落成 0.2，Anthropic 链路会被顺带改成 0.2（此前它不发送温度），
      // 那是"加一个可配项"不该带来的行为变化。
      temperature: this.config.get<number | null>('model.temperature', null),
      maxTokens: this.config.get<number | null>('model.maxTokens', null),
    };
  }

  /** 面板提交的普通配置项写入（目标：全局用户配置）。 */
  async applyPanelConfig(values: {
    baseURL?: string;
    model?: string;
    preset?: string;
    provider?: string;
    maxToolRounds?: number;
    maxContextTokens?: number;
    temperature?: number;
    maxTokens?: number;
  }): Promise<void> {
    if (values.baseURL !== undefined) await this.config.update('model.baseURL', values.baseURL || '');
    if (values.model !== undefined) await this.config.update('model.model', values.model || '');
    if (values.preset !== undefined) await this.config.update('preset', values.preset || 'default');
    if (values.provider !== undefined) await this.config.update('model.provider', values.provider || 'auto');
    if (values.maxToolRounds !== undefined) {
      await this.config.update('agent.maxToolRounds', clampInt(values.maxToolRounds, 1, 50, DEFAULT_MAX_TOOL_ROUNDS));
    }
    if (values.maxContextTokens !== undefined) {
      await this.config.update(
        'agent.maxContextTokens',
        clampInt(values.maxContextTokens, 4_000, 1_000_000, DEFAULT_MAX_CONTEXT_TOKENS)
      );
    }
    // 采样参数：temperature 是小数，不能走 clampInt（会把 0.2 四舍五入成 0）；
    // 越界值钳制到区间，非数字则**丢弃本次写入** —— 用户没填 ≠ 他想改成缺省值。
    if (values.temperature !== undefined) {
      const t = clampNumber(values.temperature, TEMPERATURE_RANGE.min, TEMPERATURE_RANGE.max);
      if (t !== undefined) await this.config.update('model.temperature', t);
    }
    if (values.maxTokens !== undefined) {
      const m = clampNumber(values.maxTokens, MAX_OUTPUT_TOKENS_RANGE.min, MAX_OUTPUT_TOKENS_RANGE.max);
      if (m !== undefined) await this.config.update('model.maxTokens', Math.round(m));
    }
  }
}

/**
 * 收敛面板提交的数值：非数字回落到缺省，越界钳制到 [min, max]。
 *
 * 为什么要在写入侧钳制而不只靠 `minimum`/`maximum` 声明：面板输入框可以被绕过
 * （浏览器开发者工具改 value 后照样提交），而这两个值直接决定"一轮能跑多少工具、上下文多大"，
 * 写进配置后会被 daemon 无条件采用。
 */
function clampInt(value: number, min: number, max: number, fallback: number): number {
  const n = clampNumber(value, min, max);
  return n === undefined ? fallback : Math.round(n);
}

/** 收敛任意输入到 [min, max]（保留小数）；非数字返回 undefined，由调用方决定怎么处理。 */
function clampNumber(value: number, min: number, max: number): number | undefined {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, n));
}