/**
 * 空态建议池的纯逻辑测试（不碰 DOM）。
 *
 * 锁的是设计决策，不是实现：
 *  - 池子里每条都能直接当 prompt 用（缺 prompt 的建议项点下去只会清空输入框）；
 *  - 单屏给几条 = SUGGEST_COUNT，且**同批不重复**；
 *  - 轮换是确定性的（同会话号同结果），但不同会话号要真的换（否则"每次新建会话都一模一样"又回来了）；
 *  - 演示模式专属项不参与轮换（它由 media/webview.js 单独追加）。
 */
import { describe, expect, it } from 'vitest';
import {
  SUGGEST_COUNT,
  SUGGEST_ICONS,
  SUGGESTION_POOL,
  demoSuggestions,
  hashSeed,
  pickSuggestions,
} from './suggestions.js';

/** 截图上的那两条（用户明确要求：新页面的可选内容不能和它们一模一样） */
const SCREENSHOT_PROMPTS = ['解释当前文件的关键逻辑，并指出潜在问题', '请修改当前文件中的 TODO'];

describe('空态建议池', () => {
  it('每条建议都可直接用：key / 文案 / prompt 齐全，图标有定义', () => {
    expect(SUGGESTION_POOL.length).toBeGreaterThanOrEqual(SUGGEST_COUNT + 1);
    const keys = new Set();
    for (const item of SUGGESTION_POOL) {
      expect(item.key).toBeTruthy();
      expect(keys.has(item.key)).toBe(false);
      keys.add(item.key);
      expect(item.bold).toBeTruthy();
      expect(item.text).toBeTruthy();
      expect(item.prompt.trim().length).toBeGreaterThan(4);
      // 图标必须是池内声明的 SVG，否则界面会渲染出一个空白圆点
      expect(SUGGEST_ICONS[item.icon]).toMatch(/^<svg /);
    }
  });

  it('单屏取 SUGGEST_COUNT 条且不重复', () => {
    for (const seed of ['', 'sess_a', 'sess_b', 'sess_mufme3j', 'sess_preview_9f3a1c7e']) {
      const picked = pickSuggestions(SUGGESTION_POOL, seed);
      expect(picked).toHaveLength(SUGGEST_COUNT);
      expect(new Set(picked.map((i) => i.key)).size).toBe(SUGGEST_COUNT);
      // 演示模式专属项绝不能混进来
      expect(picked.some((i) => i.demoOnly)).toBe(false);
    }
  });

  it('确定性：同一会话号必然得到同一组', () => {
    const a = pickSuggestions(SUGGESTION_POOL, 'sess_same').map((i) => i.key);
    const b = pickSuggestions(SUGGESTION_POOL, 'sess_same').map((i) => i.key);
    expect(a).toEqual(b);
    expect(hashSeed('sess_same')).toBe(hashSeed('sess_same'));
  });

  it('轮换真的在换：多个会话号覆盖到池里全部条目，且不止一种组合', () => {
    const seen = new Set();
    const combos = new Set();
    for (let i = 0; i < 60; i += 1) {
      const picked = pickSuggestions(SUGGESTION_POOL, `sess_${i}`);
      picked.forEach((item) => seen.add(item.key));
      combos.add(picked.map((item) => item.key).join('|'));
    }
    expect(combos.size).toBeGreaterThan(1);
    // 池子是活的：轮换要能覆盖到全部非 demo 条目，否则等于写死了几条
    const general = SUGGESTION_POOL.filter((i) => !i.demoOnly);
    expect(seen.size).toBe(general.length);
  });

  it('任何会话号下都给不出"和截图一模一样"的一组', () => {
    // 用户要求：新建会话后的可选内容不能和截图那两条一模一样。
    // 结构上就成立——单屏 3 条 ≠ 截图 2 条；这里顺带把"两条都在同一屏"这种近似情况也钉住。
    for (let i = 0; i < 40; i += 1) {
      const prompts = pickSuggestions(SUGGESTION_POOL, `s_${i}`).map((item) => item.prompt);
      expect(prompts).not.toEqual(SCREENSHOT_PROMPTS);
      expect(prompts.some((p) => !SCREENSHOT_PROMPTS.includes(p))).toBe(true);
    }
  });

  it('演示模式专属项单独取，且只有 mock 场景用得上', () => {
    const demo = demoSuggestions(SUGGESTION_POOL);
    expect(demo).toHaveLength(1);
    expect(demo[0].prompt).toContain('danger');
    expect(SUGGESTION_POOL.filter((i) => !i.demoOnly).some((i) => i.key === demo[0].key)).toBe(false);
  });

  it('边界：空池 / 非法 count 不抛错', () => {
    expect(pickSuggestions([], 'x')).toEqual([]);
    expect(pickSuggestions(SUGGESTION_POOL, 'x', 0)).toEqual([]);
    expect(pickSuggestions(SUGGESTION_POOL, 'x', 999)).toHaveLength(
      SUGGESTION_POOL.filter((i) => !i.demoOnly).length,
    );
  });
});
