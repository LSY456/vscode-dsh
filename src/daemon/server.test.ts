import { describe, expect, it } from 'vitest';
import { createConnectionRuntime, resolveAgentDecision, resolveAgentMode, RuntimeConfig, withChangedFiles } from './server';
import { DEFAULT_APPROVAL_TTL_MS } from './sessionManager';

/**
 * P0-4 回归：能力与运行时配置必须**连接级**，不得是服务实例级。
 *
 * 背景：daemon 可被同一工作区的多个 VSCode 窗口复用（auto 探测复用 .dsh/daemon.json），
 * 旧实现把 capabilities / approvalTtlMs / 模型配置挂在服务实例上，最后一个 initialize
 * 会整体覆盖所有人——A 窗口声明的 allowedTools 白名单会被 B 窗口的空配置静默冲掉。
 *
 * 这里锁定的两件事：
 *  1. createConnectionRuntime 每次调用产出的对象**互不共享引用**（隔离的物理前提）；
 *  2. resolveAgentMode 的 auto 切换语义（有 apiKey 走真实模型）。
 */

function base(): Parameters<typeof createConnectionRuntime>[0] {
  return { token: 't', workspaceRoot: '/tmp/ws' };
}

describe('createConnectionRuntime（P0-4 连接级隔离）', () => {
  it('两次调用产出相互独立的 capabilities（改一个不影响另一个）', () => {
    const a = createConnectionRuntime(base());
    const b = createConnectionRuntime(base());

    // 模拟 A 连接 initialize 声明白名单
    a.capabilities.allowedTools.push('read_file');
    a.capabilities.allowedDirs.push('/tmp/ws/sub');
    a.capabilities.maxConcurrency = 2;

    expect(b.capabilities.allowedTools).toEqual([]);
    expect(b.capabilities.allowedDirs).toEqual([]);
    expect(b.capabilities.maxConcurrency).toBe(0);
  });

  it('两次调用产出相互独立的 runtime（apiKey / model 不串味）', () => {
    const a = createConnectionRuntime(base());
    const b = createConnectionRuntime(base());

    a.runtime.apiKey = 'sk-a';
    a.runtime.baseURL = 'https://a.example/v1';
    a.runtime.model = 'model-a';
    a.runtime.agent = 'real';

    expect(b.runtime.apiKey).toBe('');
    expect(b.runtime.baseURL).toBe('');
    expect(b.runtime.model).toBe('');
    expect(b.runtime.agent).toBe('auto');
  });

  it('数组字段不是同一引用（防隐式共享）', () => {
    const a = createConnectionRuntime(base());
    const b = createConnectionRuntime(base());
    expect(a.capabilities.allowedTools).not.toBe(b.capabilities.allowedTools);
    expect(a.capabilities.allowedDirs).not.toBe(b.capabilities.allowedDirs);
  });

  it('缺省值来自 CLI 参数与常量', () => {
    const rt = createConnectionRuntime({
      token: 't',
      workspaceRoot: '/tmp/ws',
      apiKey: 'sk-cli',
      preset: 'fast',
      agent: 'mock',
      provider: 'anthropic',
    });
    expect(rt.runtime.apiKey).toBe('sk-cli');
    expect(rt.runtime.preset).toBe('fast');
    expect(rt.runtime.agent).toBe('mock');
    expect(rt.runtime.provider).toBe('anthropic');
    // 白名单缺省为空 = 全部允许（由 Agent 侧解释该语义）
    expect(rt.capabilities.allowedTools).toEqual([]);
    expect(rt.approvalTtlMs).toBe(DEFAULT_APPROVAL_TTL_MS);
  });

  it('未传 CLI 参数时 agent/provider 缺省为 auto', () => {
    const rt = createConnectionRuntime(base());
    expect(rt.runtime.agent).toBe('auto');
    expect(rt.runtime.provider).toBe('auto');
    expect(rt.runtime.apiKey).toBe('');
  });
});

describe('resolveAgentMode（auto 切换）', () => {
  const mk = (over: Partial<RuntimeConfig>): RuntimeConfig => ({
    apiKey: '',
    baseURL: '',
    model: '',
    agent: 'auto',
    provider: 'auto',
    ...over,
  });

  it('显式 real 优先，即便无 apiKey', () => {
    expect(resolveAgentMode(mk({ agent: 'real' }))).toBe('real');
  });

  it('显式 mock 优先，即便有 apiKey', () => {
    expect(resolveAgentMode(mk({ agent: 'mock', apiKey: 'sk-x' }))).toBe('mock');
  });

  it('auto + 有 apiKey -> real', () => {
    expect(resolveAgentMode(mk({ agent: 'auto', apiKey: 'sk-x' }))).toBe('real');
  });

  it('auto + 无 apiKey -> mock', () => {
    expect(resolveAgentMode(mk({ agent: 'auto' }))).toBe('mock');
    expect(resolveAgentMode(mk({ agent: 'auto', apiKey: '' }))).toBe('mock');
  });
});

/**
 * 「静默降级成 mock」防护：模式之外还必须给出**成因**，UI 才能提示"演示模式"。
 * 没有成因时，用户看到的关键字模拟回复会被误当成真实模型输出。
 */
describe('resolveAgentDecision（模式 + 成因）', () => {
  const mk = (over: Partial<RuntimeConfig>): RuntimeConfig => ({
    apiKey: '',
    baseURL: '',
    model: '',
    agent: 'auto',
    provider: 'auto',
    ...over,
  });

  it('auto + 无 apiKey -> mock，并给出 no-api-key 成因', () => {
    expect(resolveAgentDecision(mk({ agent: 'auto' }))).toEqual({
      mode: 'mock',
      reason: 'no-api-key',
    });
  });

  it('显式 mock -> mock，并给出 forced-mock 成因（与"忘了配 Key"区分）', () => {
    expect(resolveAgentDecision(mk({ agent: 'mock', apiKey: 'sk-x' }))).toEqual({
      mode: 'mock',
      reason: 'forced-mock',
    });
  });

  it('走真实模型时不带成因（没有需要解释的降级）', () => {
    expect(resolveAgentDecision(mk({ agent: 'auto', apiKey: 'sk-x' }))).toEqual({ mode: 'real' });
    expect(resolveAgentDecision(mk({ agent: 'real' }))).toEqual({ mode: 'real' });
  });

  it('与 resolveAgentMode 同源：任何输入下模式的结论都一致', () => {
    const cases: Partial<RuntimeConfig>[] = [
      { agent: 'auto' },
      { agent: 'auto', apiKey: 'sk-x' },
      { agent: 'mock', apiKey: 'sk-x' },
      { agent: 'real' },
    ];
    for (const c of cases) {
      expect(resolveAgentMode(mk(c))).toBe(resolveAgentDecision(mk(c)).mode);
    }
  });
});

/**
 * 批次 11-3：会话结束时给 `SessionEnded` 补 `changedFiles`。
 *
 * 这个数是面板「本次会话改动了 N 个文件，可一键回滚」的唯一来源。两个分支最要紧：
 * 0 是**有效事实**（面板据此不提示），而读不出来时**不能**补 0 ——
 * "0 个文件"会让用户以为没什么可回滚，正好与事实相反。
 */
describe('withChangedFiles（批次 11-3 回滚可发现性）', () => {
  it('为空时补上快照条目数', () => {
    const p: { sessionId: string; changedFiles?: number } = { sessionId: 's1' };
    withChangedFiles(p, () => 3);
    expect(p.changedFiles).toBe(3);
  });

  it('0 也如实写入：会话结束但确实没改动，是有效事实', () => {
    const p: { sessionId: string; changedFiles?: number } = { sessionId: 's1' };
    withChangedFiles(p, () => 0);
    expect(p.changedFiles).toBe(0);
  });

  it('发射方自己算过就不覆盖（幂等，以发射方为准）', () => {
    const p = { sessionId: 's1', changedFiles: 7 };
    withChangedFiles(p, () => 3);
    expect(p.changedFiles).toBe(7);
  });

  it('读不出索引时**不补**，绝不用 0 冒充', () => {
    const p: { sessionId: string; changedFiles?: number } = { sessionId: 's1' };
    withChangedFiles(p, () => {
      throw new Error('EACCES');
    });
    expect('changedFiles' in p).toBe(false);
  });

  it('非有限值（NaN / 负数）不写入：宁可没有这个字段，也不给错的数', () => {
    const a: { sessionId: string; changedFiles?: number } = { sessionId: 's1' };
    withChangedFiles(a, () => Number.NaN);
    expect('changedFiles' in a).toBe(false);

    const b: { sessionId: string; changedFiles?: number } = { sessionId: 's1' };
    withChangedFiles(b, () => -1);
    expect('changedFiles' in b).toBe(false);
  });
});
