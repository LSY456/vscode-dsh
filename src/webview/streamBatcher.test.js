/**
 * streamBatcher 的真实场景测试（A2）。
 * 验证的不是「定时器有没有被调用」，而是真实流式场景真正关心的两点：
 *  1. 正确性：批量/高频 delta 经批处理后逐个字符完整、顺序正确（绝不丢字）；
 *  2. 性能：同一时间片内大量 delta 只产生极少的 DOM 写（写次数 << append 次数）；
 * 以及生命周期边界 flush()（消息结束）/ reset()（清空视图）的确定行为。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBatcher } from './streamBatcher.js';

// 用 setTimeout 路径（raf:false）+ fake timers，保证对「节流时机」的可控与可断言
afterEach(() => {
  vi.useRealTimers();
});

describe('streamBatcher：流式正确性（不丢字、顺序正确）', () => {
  it('连续高频 delta 经一次 flush 后逐字完整、顺序正确', () => {
    vi.useFakeTimers();
    const written = [];
    const batcher = createBatcher((t) => written.push(t), { raf: false, frameMs: 16 });
    // 模拟 500 个 token 的流式输出
    for (let i = 0; i < 500; i++) batcher.append(`tok${i} `);
    vi.advanceTimersByTime(16);
    const expected = Array.from({ length: 500 }, (_, i) => `tok${i} `).join('');
    expect(written.join('')).toBe(expected);
  });

  it('多段 flush 拼接后仍完整（跨帧流式）', () => {
    vi.useFakeTimers();
    const written = [];
    const batcher = createBatcher((t) => written.push(t), { raf: false, frameMs: 16 });
    batcher.append('第一段');
    vi.advanceTimersByTime(16);
    batcher.append('第二段');
    vi.advanceTimersByTime(16);
    expect(written.join('')).toBe('第一段第二段');
  });
});

describe('streamBatcher：批处理降低 DOM 写次数（性能）', () => {
  it('同一时间片内 200 次 append 只触发 1 次写', () => {
    vi.useFakeTimers();
    let writes = 0;
    const batcher = createBatcher(() => { writes += 1; }, { raf: false, frameMs: 16 });
    for (let i = 0; i < 200; i++) batcher.append('x');
    expect(writes).toBe(0); // 帧未到，严禁写
    vi.advanceTimersByTime(16);
    expect(writes).toBe(1); // 200 -> 1
  });

  it('空 delta 不触发任何写', () => {
    vi.useFakeTimers();
    let writes = 0;
    const batcher = createBatcher(() => { writes += 1; }, { raf: false, frameMs: 16 });
    batcher.append('');
    batcher.append(null);
    batcher.append(undefined);
    vi.advanceTimersByTime(100);
    expect(writes).toBe(0);
  });
});

describe('streamBatcher：生命周期边界', () => {
  it('flush() 立即写出剩余缓冲（message.done 场景，不等帧）', () => {
    vi.useFakeTimers();
    const written = [];
    const batcher = createBatcher((t) => written.push(t), { raf: false, frameMs: 16 });
    batcher.append('最后一段 token');
    batcher.flush();
    expect(written.join('')).toBe('最后一段 token');
  });

  it('flush() 在无缓冲时是空操作', () => {
    vi.useFakeTimers();
    let writes = 0;
    const batcher = createBatcher(() => { writes += 1; }, { raf: false, frameMs: 16 });
    batcher.flush();
    expect(writes).toBe(0);
  });

  it('reset() 丢弃挂起内容与定时器（清空视图场景）', () => {
    vi.useFakeTimers();
    let writes = 0;
    const batcher = createBatcher(() => { writes += 1; }, { raf: false, frameMs: 16 });
    batcher.append('将被丢弃');
    batcher.reset();
    vi.advanceTimersByTime(100);
    expect(writes).toBe(0);
  });
});