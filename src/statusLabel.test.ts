/**
 * 状态文案（P1-3）验证。
 *
 * 要钉住的核心：**每个状态都有中文文案，且不会把内部枚举原样丢给用户**。
 * 旧实现在状态栏里拼 `dsh: connected`、通知里拼 `dsh daemon 状态: connecting` ——
 * 用户看不懂，而面板里其实另有一份中文映射（两处漂移的典型）。
 */
import { describe, expect, it } from 'vitest';
import { DAEMON_STATE_LABEL, DaemonState, daemonStateLabel } from './statusLabel';

/** 状态机全集：与 src/daemonManager.ts 的 DaemonStatus 同源（statusLabel 是唯一定义处） */
const ALL_STATES: DaemonState[] = [
  'stopped',
  'starting',
  'connecting',
  'connected',
  'error',
  'disabled',
  'restricted',
];

describe('daemonStateLabel：状态文案的唯一来源', () => {
  it('每个状态都有非空中文文案', () => {
    for (const state of ALL_STATES) {
      const label = daemonStateLabel(state);
      expect(label, `${state} 缺少文案`).toBeTruthy();
      expect(label).toBe(DAEMON_STATE_LABEL[state]);
    }
  });

  it('没有把内部枚举原样透出（文案不能等于状态名本身）', () => {
    for (const state of ALL_STATES) {
      expect(daemonStateLabel(state), `${state} 未经翻译就展示给用户`).not.toBe(state);
    }
  });

  it('状态 → 文案映射没有多余条目（防拼写漂移悄悄多出一个死键）', () => {
    expect(Object.keys(DAEMON_STATE_LABEL).sort()).toEqual([...ALL_STATES].sort());
  });

  it('受限模式与「仅 UI 模式」是两个不同概念，不可混为一谈', () => {
    // restricted = 工作区未被信任（安全默认值）；disabled = 没打开文件夹 / mode=none（能力被关掉）
    expect(daemonStateLabel('restricted')).toBe('受限模式');
    expect(daemonStateLabel('disabled')).toBe('仅 UI 模式');
  });

  it('未知取值原样透出（便于发现协议新增状态），空值给「未知」', () => {
    expect(daemonStateLabel('brand-new-state')).toBe('brand-new-state');
    expect(daemonStateLabel(undefined)).toBe('未知');
    expect(daemonStateLabel(null)).toBe('未知');
    expect(daemonStateLabel('')).toBe('未知');
  });
});
