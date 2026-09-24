/**
 * 空态建议项（starter prompts）：一个按意图分类的池子 + 确定性轮换。
 *
 * 为什么不是写死三条（也就是截图里那两条的来历）：
 *  ① 空态建议的价值在于"给一个能立刻上手的起点"。写死的几条在**每次新建会话后**都会原样重现，
 *     看第二眼就退化成装饰；而不同会话要干的事本来就不同（读代码 / 改代码 / 排错 / 补测试 / 写提交信息…）。
 *  ② 截图里那两条（解释当前文件 / 修改 TODO）只覆盖"读现有文件"这一种场景，对新任务并不总是有意义
 *     —— 所以这里扩成池子，每次空态换着给，且单屏给出的条数与截图不同（见 SUGGEST_COUNT）。
 *
 * 轮换是**确定性**的：同一个 seed（会话号）必然得到同一组建议，便于单测与问题复现，
 * 而不是每次刷新都变（那样用户会觉得界面在抽风）。
 *
 * 演示模式专属项（demoOnly）不参与轮换，由 media/webview.js 单独追加（mock 下靠它的关键字"咒语"演示审批链路）。
 */

/** 单屏给几条。取 3：常见面板高度下不会把空态撑出滚动条，也给轮换留出组合空间。 */
export const SUGGEST_COUNT = 3;

/**
 * 16×16 描边图标，与面板其余图标同源：currentColor、1.3 描边、无填充。
 * 放在这里而不是 HTML 模板里，是为了"加一条建议"只需改本文件一处。
 */
export const SUGGEST_ICONS = {
  question:
    '<svg viewBox="0 0 16 16" width="14" height="14" focusable="false">' +
    '<circle cx="8" cy="8" r="5.3" fill="none" stroke="currentColor" stroke-width="1.3"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" d="M6.6 6.4a1.5 1.5 0 1 1 1.9 1.5c-.4.2-.6.4-.6.9"/>' +
    '<circle cx="8" cy="11" r="0.7" fill="currentColor"/>' +
    '</svg>',
  warning:
    '<svg viewBox="0 0 16 16" width="14" height="14" focusable="false">' +
    '<path fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" d="M8 2.4l5.2 9.2H2.8z"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" d="M8 6.4v2.6"/>' +
    '<circle cx="8" cy="10.6" r="0.7" fill="currentColor"/>' +
    '</svg>',
  pencil:
    '<svg viewBox="0 0 16 16" width="14" height="14" focusable="false">' +
    '<path fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" d="M10.4 3.6l2 2L6 12H4v-2z"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" d="M2.6 14h10.8"/>' +
    '</svg>',
  flask:
    '<svg viewBox="0 0 16 16" width="14" height="14" focusable="false">' +
    '<path fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" d="M6.4 2.2h3.2M7 2.4v3.1L3.9 11.4A1.4 1.4 0 0 0 5.1 13.6h5.8a1.4 1.4 0 0 0 1.2-2.2L9 5.5V2.4"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" d="M5.4 9.6h5.2"/>' +
    '</svg>',
  search:
    '<svg viewBox="0 0 16 16" width="14" height="14" focusable="false">' +
    '<circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" stroke-width="1.3"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" d="M10.2 10.2L13.4 13.4"/>' +
    '</svg>',
  target:
    '<svg viewBox="0 0 16 16" width="14" height="14" focusable="false">' +
    '<circle cx="8" cy="8" r="3.2" fill="none" stroke="currentColor" stroke-width="1.3"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" d="M8 1.6v2.4M8 12v2.4M1.6 8h2.4M12 8h2.4"/>' +
    '</svg>',
  book:
    '<svg viewBox="0 0 16 16" width="14" height="14" focusable="false">' +
    '<path fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" d="M8 4.2C7 3.2 5.6 2.8 3.6 2.8v9c2 0 3.4.4 4.4 1.4 1-1 2.4-1.4 4.4-1.4v-9c-2 0-3.4.4-4.4 1.4z"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" d="M8 4.2v9"/>' +
    '</svg>',
  check:
    '<svg viewBox="0 0 16 16" width="14" height="14" focusable="false">' +
    '<path fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" d="M3.4 8.6l2.8 2.8 6-6.4"/>' +
    '</svg>',
  layers:
    '<svg viewBox="0 0 16 16" width="14" height="14" focusable="false">' +
    '<path fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" d="M8 2.4l5.2 2.6L8 7.6 2.8 5z"/>' +
    '<path fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" d="M2.8 9l5.2 2.6L13.2 9"/>' +
    '</svg>',
  bolt:
    '<svg viewBox="0 0 16 16" width="14" height="14" focusable="false">' +
    '<path fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" d="M8.8 1.8L4 9h3.4l-.9 5.2L11.4 7H8z"/>' +
    '</svg>',
};

/**
 * 建议池。`bold` 是行首被强调的那两个字，`text` 是其余说明（结构与旧版一致）。
 * `prompt` 是点击后填入输入框的完整文案（**填入而不直接发送**，避免误触）。
 *
 * 通用条目一律用自然语言，不掺演示模式的"咒语"：一是真实模型下不该把内部演示语法教给用户，
 * 二是轮换后这些条目未必在屏上，「咒语」绑在它们身上会时灵时不灵。演示入口单独作为 demoOnly 条目。
 */
export const SUGGESTION_POOL = [
  {
    key: 'explain',
    icon: 'question',
    bold: '解释',
    text: '当前文件的关键逻辑',
    prompt: '解释当前文件的关键逻辑，并指出潜在问题',
  },
  {
    key: 'diagnostics',
    icon: 'warning',
    bold: '排查',
    text: '当前编辑器诊断里的报错',
    prompt: '看看当前编辑器诊断里的报错，定位原因并给出修复方案',
  },
  {
    key: 'todo',
    icon: 'pencil',
    bold: '修改',
    text: '当前文件里的 TODO',
    prompt: '请修改当前文件中的 TODO',
  },
  {
    key: 'test',
    icon: 'flask',
    bold: '补测',
    text: '给当前文件写一份单测',
    prompt: '为当前文件补一份单元测试，覆盖主要分支和边界情况',
  },
  {
    key: 'review',
    icon: 'search',
    bold: '评审',
    text: '我这次改动的风险点',
    prompt: '评审一下我当前的改动（git diff），指出风险和遗漏',
  },
  {
    key: 'locate',
    icon: 'target',
    bold: '定位',
    text: '某个符号的定义与调用点',
    prompt: '帮我定位一个符号：它在哪里定义、被哪些地方调用',
  },
  {
    key: 'overview',
    icon: 'book',
    bold: '通读',
    text: '这个仓库的结构与入口',
    prompt: '通读这个仓库，说明目录结构与主要入口',
  },
  {
    key: 'commit',
    icon: 'check',
    bold: '起草',
    text: '本次改动的提交信息',
    prompt: '根据当前改动帮我起草一条提交信息',
  },
  {
    key: 'refactor',
    icon: 'layers',
    bold: '重构',
    text: '当前文件里重复的逻辑',
    prompt: '找出当前文件里重复的逻辑，给出重构建议',
  },
  {
    key: 'demo-approval',
    icon: 'bolt',
    bold: '演示',
    text: '高危工具审批流程（仅演示模式）',
    prompt: '危险操作：请运行 bash rm -rf（danger）',
    demoOnly: true,
  },
];

/**
 * FNV-1a 32 位散列（与脚本指纹同一套算法，项目内无第二套实现）。
 * 必须用 Math.imul：普通乘法在 32 位量级下会超过 2^53，静默丢精度后散列就退化了。
 */
export function hashSeed(seed) {
  const text = String(seed === undefined || seed === null ? '' : seed);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** 演示模式专属项（不参与轮换，单独追加在后） */
export function demoSuggestions(pool = SUGGESTION_POOL) {
  return (Array.isArray(pool) ? pool : []).filter((item) => item && item.demoOnly);
}

/**
 * 按 seed 从池中取 count 条（环形轮换，同批不重复）。
 * seed 取会话号：新建会话 → 新会话号 → 新组合。
 */
export function pickSuggestions(pool = SUGGESTION_POOL, seed = '', count = SUGGEST_COUNT) {
  const general = (Array.isArray(pool) ? pool : []).filter((item) => item && !item.demoOnly);
  if (general.length === 0) return [];
  const take = Math.max(0, Math.min(Math.floor(count) || 0, general.length));
  const start = hashSeed(seed) % general.length;
  const picked = [];
  for (let i = 0; i < take; i += 1) {
    picked.push(general[(start + i) % general.length]);
  }
  return picked;
}
