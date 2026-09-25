/**
 * 工作区信任门禁的策略测试（纯逻辑，不碰 vscode）。
 *
 * 锁的是"安全默认值"：
 *  - 未信任 → blocked，且必须给出**可执行的下一步**（有 banner + 明确的动作按钮），
 *    否则用户只会看到"不能用"而不知道怎么办；
 *  - 已信任 → 不阻断、无横幅（不能因为"顺手"就把正常路径也显示上限提示）；
 *  - 文案不得出现英文枚举（`untrusted` / `disabled` 这类内部词不该给用户看）。
 */
import { describe, expect, it } from 'vitest';
import { TRUST_MANAGE_COMMAND, resolveTrustGate } from './workspaceTrust';

describe('工作区信任门禁', () => {
  it('已信任：不阻断、无横幅、状态标签为空', () => {
    const gate = resolveTrustGate(true);
    expect(gate.blocked).toBe(false);
    expect(gate.banner).toBe(null);
    expect(gate.statusLabel).toBe('');
    expect(gate.statusDetail).toBe('');
  });

  it('未信任：阻断启动，并给出可执行的下一步', () => {
    const gate = resolveTrustGate(false);
    expect(gate.blocked).toBe(true);
    expect(gate.statusLabel).toBe('受限模式');
    expect(gate.banner).toBeTruthy();
    expect(gate.banner?.tag).toBe('受限模式');
    // 横幅必须带动作按钮，否则用户只知道"不能用"
    expect(gate.banner?.actionLabel).toContain('信任');
    // 说清原因：它要读写文件 / 执行命令（而不是干巴巴的"操作被禁止"）
    expect(gate.banner?.text).toContain('未启动');
    expect(gate.banner?.text).toContain('.dsh/');
    expect(gate.statusDetail).toContain('受限模式');
  });

  it('文案面向用户：不出现协议/状态机里的英文枚举', () => {
    const gate = resolveTrustGate(false);
    for (const text of [gate.statusLabel, gate.statusDetail, gate.banner?.tag, gate.banner?.text, gate.banner?.actionLabel]) {
      expect(String(text)).not.toMatch(/untrusted|disabled|isTrusted|restricted/i);
    }
  });

  it('是纯函数：同入参必然同出参，且返回值互不共享可变状态', () => {
    const a = resolveTrustGate(false);
    const b = resolveTrustGate(false);
    expect(a).toEqual(b);
    a.banner!.tag = '被改坏了';
    expect(resolveTrustGate(false).banner?.tag).toBe('受限模式');
  });

  it('信任入口指向 VS Code 内置的工作区信任管理命令', () => {
    // UI 的"信任此工作区"按钮与扩展命令共用这一个出口，写错了按钮就点了没反应
    expect(TRUST_MANAGE_COMMAND).toBe('workbench.trust.manage');
  });
});
