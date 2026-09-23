import { describe, expect, it } from 'vitest';
import {
  STREAM_RENDER_BUDGET_CHARS,
  STREAM_RENDER_MAX_MS,
  STREAM_RENDER_MIN_MS,
  streamRenderIntervalMs,
} from './streamRenderPolicy.js';

/**
 * 这些断言锁定的是「流式渲染为什么必须节流」这条设计决策，
 * 而不是某个具体数字——数字可以调，但"成本不能随体量线性上涨"这条不变式不能破。
 */
describe('流式渲染节流策略', () => {
  it('短文本用最小间隔，跟着 token 走也不会掉帧', () => {
    for (const len of [0, 1, 500, STREAM_RENDER_BUDGET_CHARS]) {
      expect(streamRenderIntervalMs(len)).toBe(STREAM_RENDER_MIN_MS);
    }
  });

  it('超过体量基准后按比例退避，且不超过上限', () => {
    expect(streamRenderIntervalMs(STREAM_RENDER_BUDGET_CHARS * 2)).toBe(STREAM_RENDER_MIN_MS * 2);
    expect(streamRenderIntervalMs(200_000)).toBeLessThanOrEqual(STREAM_RENDER_MAX_MS);
    expect(streamRenderIntervalMs(10_000_000)).toBe(STREAM_RENDER_MAX_MS);
  });

  it('单调不减：文本越长，落得越疏', () => {
    let prev = 0;
    for (const len of [0, 100, 1000, 5000, 8000, 20_000, 50_000, 200_000, 1_000_000]) {
      const cur = streamRenderIntervalMs(len);
      expect(cur).toBeGreaterThanOrEqual(prev);
      prev = cur;
    }
  });

  /**
   * 核心不变式：在退避区间（8K..100K）内，`文本长度 / 渲染间隔` 是常数。
   * 由于单次渲染成本 ∝ 文本长度，这就等价于「每秒的渲染总成本与文本长度无关」——
   * 也就是逐帧渲染会吃满 CPU、而本策略不会的原因。若有人把间隔改回固定值，
   * 这条会立刻失败（固定 80ms 时该比值随长度线性上涨 100 倍）。
   */
  it('退避区间内「长度 / 间隔」保持常数：把 CPU 占比与体量解耦', () => {
    const ratios = [8000, 16_000, 40_000, 80_000].map((len) => len / streamRenderIntervalMs(len));
    for (const r of ratios) expect(r).toBeCloseTo(100, 5);
  });

  it('非法输入（NaN / 负数）退化为最小间隔，不产生 NaN 定时器', () => {
    expect(streamRenderIntervalMs(NaN)).toBe(STREAM_RENDER_MIN_MS);
    expect(streamRenderIntervalMs(-1)).toBe(STREAM_RENDER_MIN_MS);
  });
});
