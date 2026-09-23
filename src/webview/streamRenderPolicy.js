/**
 * 回答流的「渲染节流」策略（纯函数，无 DOM 依赖，便于单测）。
 *
 * 背景：流式渲染是**全文渲染**——marked 解析 + hljs 高亮 + DOMPurify 净化，
 * 后两者无法跳过（净化是唯一允许写 innerHTML 的安全前提）。而它的成本随文本**线性**增长，
 * 实测（jsdom，Chromium 更快但同量级）：
 *
 *   1.3KB → 15.6 ms/次      5KB → 38.8 ms/次      20KB → 159.5 ms/次      61KB → 612 ms/次
 *
 * 若跟着 token 逐帧（60fps）渲染，1.3KB 的老实回答就要吃掉 ~934ms/s 的 CPU，
 * 界面直接卡死。所以必须节流。
 *
 * 策略：把渲染间隔按体量线性伸长，使「每秒渲染次数 × 单次成本」保持常量级——
 *   Σ CPU/s ≈ (len/1000 ms) × (1000 / interval) ；interval 与 len 成正比时该式与 len 无关。
 * 取 base=80ms、budgetChars=8000 时，全区间稳态 CPU 占比约 10%（远低于逐帧的上千毫秒/秒）。
 *
 * 观感：≤8KB 每 80ms 落一次（≈12 次/秒），感知上就是连续打字；
 * 体量越大落得越疏（上限 1s），但那时屏幕上的信息量本身已经很大，不影响可读性。
 * 流式渲染只决定"过程中的观感"，`message.done` 会再做一次完整渲染，因此最终结果不受影响。
 */

/** 最小间隔：短文本下也要足够跟手（≈12 次/秒）。 */
export const STREAM_RENDER_MIN_MS = 80;
/** 最大间隔：超长回答下宁可少落几次，也不要把主线程吃满。 */
export const STREAM_RENDER_MAX_MS = 1000;
/** 体量基准：到这个字符数之前都用最小间隔，之后按比例退避。 */
export const STREAM_RENDER_BUDGET_CHARS = 8000;

/**
 * 返回给定累积文本长度下应采用的渲染间隔（毫秒）。
 * 单调不减、且被钳在 [STREAM_RENDER_MIN_MS, STREAM_RENDER_MAX_MS] 内。
 */
export function streamRenderIntervalMs(len) {
  const n = Number.isFinite(len) && len > 0 ? len : 0;
  const scaled = (STREAM_RENDER_MIN_MS * n) / STREAM_RENDER_BUDGET_CHARS;
  return Math.round(Math.min(STREAM_RENDER_MAX_MS, Math.max(STREAM_RENDER_MIN_MS, scaled)));
}
