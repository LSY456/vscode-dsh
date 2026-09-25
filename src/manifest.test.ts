// @vitest-environment node
/**
 * `package.json` 的平台契约断言（P0-1 工作区信任）。
 *
 * 为什么单独测"声明文件"：本次安全修复的防护由**三层**组成，其中两层只存在于 package.json
 * （① 受限配置项、② 机器作用域）。它们没有任何运行期代码，删掉/写错都不会有报错 ——
 * 只有人肉读 diff 才能发现。而它们恰恰是"工作区设置不能改写危险项"的唯一保证，所以钉在测试里。
 *
 * 另外顺手挡住一类真实事故：`restrictedConfigurations` 里写了不存在的配置项名（拼写漂移），
 * VS Code 不会报错，但那条防护就静默失效了。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// 与 webviewHtml.test.ts 同一套做法：测试以仓库根为 cwd 运行，直接读真实清单而不是自带副本
const pkg = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as {
  capabilities?: {
    untrustedWorkspaces?: { supported?: string; restrictedConfigurations?: string[] };
    virtualWorkspaces?: { supported?: boolean };
  };
  contributes: {
    configuration: { properties: Record<string, { scope?: string }> };
    commands: { command: string; title: string; enablement?: string }[];
  };
};

/** 会执行进程 / 触达网络 / 放开工具白名单的配置项 —— 工作区设置一律不得改写 */
const RISKY_SETTINGS = [
  'dsh.daemon.mode',
  'dsh.daemon.command',
  'dsh.daemon.port',
  'dsh.daemon.token',
  'dsh.capabilities.allowedTools',
  'dsh.model.baseURL',
];

describe('package.json 平台契约', () => {
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
