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
  getPanelConfig(): { baseURL: string; model: string; preset: string } {
    return {
      baseURL: this.config.get('model.baseURL', ''),
      model: this.config.get('model.model', ''),
      preset: this.config.get('preset', 'default'),
    };
  }

  /** 面板提交的普通配置项写入（目标：全局用户配置）。 */
  async applyPanelConfig(values: { baseURL?: string; model?: string; preset?: string }): Promise<void> {
    if (values.baseURL !== undefined) await this.config.update('model.baseURL', values.baseURL || '');
    if (values.model !== undefined) await this.config.update('model.model', values.model || '');
    if (values.preset !== undefined) await this.config.update('preset', values.preset || 'default');
  }
}