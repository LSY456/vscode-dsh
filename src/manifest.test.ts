// @vitest-environment node
/**
 * `package.json` 的平台契约断言（Batch A 工作区信任 · Batch B 平台一致性）。
 *
 * 为什么单独测"声明文件"：工作区信任的防护由**三层**组成，其中两层只存在于 package.json
 * （① 受限配置项、② 机器作用域）。它们没有任何运行期代码，删掉/写错都不会有报错 ——
 * 只有人肉读 diff 才能发现。而它们恰恰是"工作区设置不能改写危险项"的唯一保证，所以钉在测试里。
 *
 * 另外顺手挡住两类真实事故：
 *  - `restrictedConfigurations` 里写了不存在的配置项名（拼写漂移）：VS Code 不会报错，
 *    但那条防护就静默失效了；
 *  - 配置项的"契约"与实现不符（例如 apiKey 明明是密钥库存储，声明却在教用户写明文）。
 *
 * `extensionKind` 同理：它是 Remote 场景跑哪一侧的**唯一**依据，写错不会报错，
 * 只会让 daemon 在 UI 侧启动、拿着一个远端根本不存在的本地路径去干活。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// 与 webviewHtml.test.ts 同一套做法：测试以仓库根为 cwd 运行，直接读真实清单而不是自带副本
const pkg = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as {
  extensionKind?: string[];
  capabilities?: {
    untrustedWorkspaces?: { supported?: string; restrictedConfigurations?: string[] };
    virtualWorkspaces?: { supported?: boolean };
  };
  contributes: {
    configuration: {
      properties: Record<
        string,
        { scope?: string; default?: unknown; minimum?: number; description?: string; deprecationMessage?: string }
      >;
    };
    commands: { command: string; title: string; enablement?: string }[];
  };
};

/** 会执行进程 / 触达网络 / 放开工具白名单 / 携带凭据的配置项 —— 工作区设置一律不得改写 */
const RISKY_SETTINGS = [
  'dsh.daemon.mode',
  'dsh.daemon.command',
  'dsh.daemon.port',
  'dsh.daemon.token',
  'dsh.capabilities.allowedTools',
  'dsh.model.baseURL',
  'dsh.apiKey',
];

describe('package.json 平台契约：工作区信任', () => {
  it('声明了工作区信任能力：受限模式下允许运行，但危险配置项被锁', () => {
    const cap = pkg.capabilities;
    expect(cap, 'package.json 缺少 capabilities 声明').toBeTruthy();
    expect(cap?.untrustedWorkspaces?.supported).toBe('limited');
  });

  it('危险配置项全部列为受限配置（工作区设置对其不生效）', () => {
    const list = pkg.capabilities?.untrustedWorkspaces?.restrictedConfigurations ?? [];
    for (const key of RISKY_SETTINGS) {
      expect(list, `restrictedConfigurations 缺少 ${key}`).toContain(key);
    }
  });

  it('受限配置项都必须真实存在（防拼写漂移导致防护静默失效）', () => {
    const properties = pkg.contributes.configuration.properties;
    for (const key of pkg.capabilities?.untrustedWorkspaces?.restrictedConfigurations ?? []) {
      expect(properties[key], `restrictedConfigurations 声明了不存在的配置项 ${key}`).toBeTruthy();
    }
  });

  it('会执行进程的配置项钉成机器作用域（不可被工作区覆盖）', () => {
    const properties = pkg.contributes.configuration.properties;
    for (const key of ['dsh.daemon.command', 'dsh.daemon.mode', 'dsh.daemon.token']) {
      expect(properties[key]?.scope, `${key} 应为机器作用域`).toBe('machine');
    }
  });

  it('虚拟工作区声明为不支持（Agent 需要真实文件系统）', () => {
    expect(pkg.capabilities?.virtualWorkspaces?.supported).toBe(false);
  });

  it('信任入口命令已贡献，且仅在未信任时可用', () => {
    const cmd = pkg.contributes.commands.find((c) => c.command === 'dsh.trustWorkspace');
    expect(cmd, '缺少 dsh.trustWorkspace 命令').toBeTruthy();
    // isWorkspaceTrusted 是 VS Code 提供的内建上下文键：已信任时这条命令就不该出现
    expect(cmd?.enablement).toBe('!isWorkspaceTrusted');
  });
});

describe('package.json 平台契约：Remote 与配置项收敛（Batch B）', () => {
  it('extensionKind 声明为 workspace：daemon 必须在工作区侧启动', () => {
    // daemon 由扩展宿主 spawn，工作区根取自 workspaceFolders 的 fsPath。若宿主跑在 UI 侧
    // （Remote-SSH / WSL / Dev Containers），路径与进程语义全错 —— 而这不是运行期能兜住的。
    expect(pkg.extensionKind).toEqual(['workspace']);
  });

  it('dsh.apiKey 标为已弃用，且声明不再教用户写明文', () => {
    const apiKey = pkg.contributes.configuration.properties['dsh.apiKey'];
    expect(apiKey, 'dsh.apiKey 被删除前应先确认迁移路径仍然可达').toBeTruthy();
    // 契约必须与实现一致：实现是"密钥库优先 + 一次性迁移"，声明就不能再是"填 Key 到这里"
    expect(apiKey?.deprecationMessage, 'dsh.apiKey 缺少 deprecationMessage').toBeTruthy();
    expect(apiKey?.deprecationMessage).toContain('密钥库');
    expect(apiKey?.description).toContain('已弃用');
  });

  it('历史保留条数可配置（默认 50，0 = 不限）', () => {
    const max = pkg.contributes.configuration.properties['dsh.history.maxSessions'];
    expect(max, '缺少 dsh.history.maxSessions').toBeTruthy();
    expect(max?.default).toBe(50);
    expect(max?.minimum).toBe(0);
  });
});
