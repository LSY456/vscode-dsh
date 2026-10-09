/**
 * Plan 模式（P2-7）的提示词与判定：**单一来源**。
 *
 * 为什么单独成模块而不是散在 `realAgent.ts` 里：
 *  - `model.ts` 的内置关键字假模型需要识别"这一轮是计划阶段"才能给出确定性的响应
 *    （集成冒烟要断言"计划先出、批准后才写文件"）。若标记定义在 `realAgent.ts`，
 *    `model.ts` 反过来 import 它就形成循环依赖；放在这里两者都只依赖本模块。
 *  - 计划模式的"能改什么、不能改什么"是安全边界，文案与工具白名单放在一起才看得出是否自洽。
 */

/**
 * 计划模式的 system 指令前缀，**机器可读**。
 *
 * 假模型据此识别计划阶段（见 `model.ts` 的 `createKeywordFakeModel`）。
 * 改文案时不要动这个前缀，否则 `scripts/smoke.js` 的确定性断言会静默失效。
 */
export const PLAN_MODE_MARKER = '【计划模式】';

/**
 * 只读工具名。计划模式下这是**唯一**可用的工具集。
 *
 * 与 `realAgent.ts` 里 `dispatchTool` 的"只读分支"必须保持一致 ——
 * 靠提示词说"别改文件"是不可靠的，承诺必须落在工具清单这一层：
 * 模型看不到 write_file，就发不出写入调用。
 */
export const READONLY_TOOL_NAMES = ['read_file', 'list_dir', 'grep', 'glob'];

/** 计划阶段的 system 附加指令。 */
export const PLAN_SYSTEM_APPENDIX = [
  PLAN_MODE_MARKER,
  '本轮你只做**调研与写计划**，不要修改任何文件——可用工具只有 read_file / list_dir / grep / glob，',
  '写入类工具在本阶段**没有被提供**，调用它们一定失败。',
  '请先用尽可能少的只读调用把关键事实看清（相关文件、现有写法与约定、这次改动会波及的地方），',
  '然后直接输出一份给用户审阅的计划，包含四部分：',
  '1. 目标：这次要做成什么（一两句话）；',
  '2. 步骤：按执行顺序编号，每步说清做什么；',
  '3. 涉及文件：每一步会新建 / 修改 / 删除哪些文件，写清路径；',
  '4. 风险与待确认：不确定的取舍、可能影响到的其它代码，需要用户拍板的地方。',
  '计划要具体到"用户看完就能决定批不批"，不要写成泛泛的方法论。本轮到此为止，不要发起写入调用。',
].join('\n');

/**
 * 计划阶段调研预算用尽时的收束指令。
 *
 * 与主循环的 `FINAL_ANSWER_INSTRUCTION` 同一条纪律：预算跑满**必须收束成一次不带工具的请求**，
 * 让模型把已经看到的写成计划 —— 直接放弃等于把"没产出"甩给用户。
 */
export const PLAN_COLLAPSE_INSTRUCTION =
  '（系统提示）调研轮次已达上限，不能再调用任何工具。请立即基于上面已经获得的信息，' +
  '直接输出完整的计划（目标 / 按序步骤 / 涉及文件路径 / 风险与待确认）。' +
  '信息不足的地方请明确写"需要确认"，不要输出任何工具调用格式。';

/** 计划获批后追加的执行指令（note 为用户在批准时附带的补充意见）。 */
export function planApprovedInstruction(note?: string): string {
  const base = '计划已获批准，请按上面的计划开始执行。';
  const extra = note?.trim() ? `用户补充了以下要求，执行时以它为准：\n${note.trim()}` : '';
  return [base, extra].filter(Boolean).join('\n');
}

/**
 * 当前请求是否处于计划阶段（system 消息里带计划标记）。
 *
 * 供假模型与测试使用，无需知道 realAgent 的内部状态。
 */
export function isPlanPhase(messages: Array<{ role: string; content: string }>): boolean {
  return messages.some((m) => m.role === 'system' && m.content.includes(PLAN_MODE_MARKER));
}
