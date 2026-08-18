/**
 * 流式文本批处理器（A2）。
 *
 * 真实场景：模型以 token 粒度流式输出（每秒可达数十个 delta），
 * 若每个 delta 都直接写 DOM 并触发滚动，会产生高频 reflow —— 界面抖动、CPU 占用高、
 * 长回答明显卡顿。本模块把 delta 累积进缓冲区，按帧节流 flush：
 *  - 有 requestAnimationFrame 时与其对齐（Chromium/webview），每帧最多写一次 DOM；
 *  - 无 rAF 时退避为 setTimeout(frameMs)，保证可移植与可测；
 *  - flush()/reset() 供「消息结束」「清空视图」等时机精确收尾，缓冲区内容不丢失。
 *
 * 纯 ESM、无 DOM/Node 依赖，测试可在 jsdom + fake timers 下稳定运行。
 */
export function createBatcher(flush, options) {
  const opts = options || {};
  const rafEnabled = opts.raf !== false && typeof requestAnimationFrame === 'function';
  const frameMs = opts.frameMs || 16;

  let buffer = '';
  let timer = null;

  function cancel() {
    if (timer == null) return;
    if (rafEnabled) cancelAnimationFrame(timer);
    else clearTimeout(timer);
    timer = null;
  }

  function schedule() {
    if (timer != null) return;
    timer = rafEnabled ? requestAnimationFrame(run) : setTimeout(run, frameMs);
  }

  function run() {
    timer = null;
    if (!buffer) return;
    const out = buffer;
    buffer = '';
    flush(out);
  }

  return {
    /** 追加一段 delta；内容累积进缓冲区，不立即写（空值忽略）。 */
    append(text) {
      if (text == null || text === '') return;
      buffer += text;
      schedule();
    },
    /** 立即写出缓冲区的剩余内容（消息结束 / 手动同步时调用）。 */
    flush() {
      cancel();
      if (buffer) {
        const out = buffer;
        buffer = '';
        flush(out);
      }
    },
    /** 丢弃缓冲区与挂起的定时器（清空视图时调用）。 */
    reset() {
      cancel();
      buffer = '';
    },
  };
}