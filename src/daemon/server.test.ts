import { describe, expect, it } from 'vitest';
import { createConnectionRuntime, resolveAgentMode, RuntimeConfig } from './server';
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
