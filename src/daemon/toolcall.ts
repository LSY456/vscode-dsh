/**
 * 模型工具调用约定（P3.2）：助手在正文中输出一个 fenced JSON 块。
 *
 *    ```toolcall
 *    {"tool":"read_file","input":{"path":"/abs/path"}}
 *    ```
 *
 * 支持单个对象或对象数组。真实场景（P3.5+ 打磨）：真实模型可能偏离上述格式——
 * 解析器容错接受 ```toolcall / ```json / 无语言标签的 fenced 块，并在无 fenced
 * 工具调用时兜底提取含 "tool" 的裸 JSON 对象/数组；无法解析的或非工具块被忽略（非致命）。
 */

export interface ToolCall {
  tool: string;
  input: Record<string, unknown>;
}

export const TOOLCALL_FENCE = 'toolcall';

/** fenced 块首行可接受的语言标签（无标签也接受，由 JSON 形状过滤）。 */
const FENCE_TAGS: ReadonlySet<string> = new Set([TOOLCALL_FENCE, 'json']);

export function formatToolCall(call: ToolCall): string {
  return '```' + TOOLCALL_FENCE + '\n' + JSON.stringify(call) + '\n```\n';
}

export function parseToolCalls(text: string): ToolCall[] {
  const out: ToolCall[] = [];
  collectFencedToolCalls(text, out);
  if (out.length === 0) {
    // 兜底：无 fenced 工具调用时，从正文提取含 "tool" 字段的裸 JSON
    for (const candidate of extractJsonValues(text)) {
      addToolCallsFrom(out, candidate);
    }
  }
  return out;
}

/** 遍历成对的 ``` 围栏，把每个块按工具调用解析（语言标签容错）。 */
function collectFencedToolCalls(text: string, out: ToolCall[]): void {
  const fence = '```';
  let cursor = 0;
  for (;;) {
    const open = text.indexOf(fence, cursor);
    if (open === -1) return;
    const close = text.indexOf(fence, open + fence.length);
    if (close === -1) return;
    addToolCallsFrom(out, stripFenceTag(text.slice(open + fence.length, close)));
    cursor = close + fence.length;
  }
}

/** 去掉 fenced 块首行的语言标签（toolcall / json / 空行）。 */
function stripFenceTag(block: string): string {
  const nl = block.indexOf('\n');
  if (nl === -1) return block;
  const first = block.slice(0, nl).trim();
  return first === '' || FENCE_TAGS.has(first) ? block.slice(nl + 1) : block;
}

/** 将一段原始文本解析为单个对象或数组，逐个转换并保留有效工具调用。 */
function addToolCallsFrom(out: ToolCall[], raw: string): void {
  const parsed = tryParseJson(raw.trim());
  if (parsed === undefined) return;
  const items = Array.isArray(parsed) ? parsed : [parsed];
  for (const item of items) {
    const tc = coerceToolCall(item);
    if (tc.tool) out.push(tc);
  }
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * 用括号配对扫描提取文本中的裸 JSON 值（对象/数组），跳过字符串字面量与转义，
 * 仅保留含 "tool" 字段的候选。
 */
function extractJsonValues(text: string): string[] {
  const out: string[] = [];
  const stack: string[] = [];
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{' || ch === '[') {
      if (stack.length === 0) start = i;
      stack.push(ch);
    } else if (ch === '}' || ch === ']') {
      const open = stack.length ? stack[stack.length - 1] : undefined;
      if ((open === '{' && ch === '}') || (open === '[' && ch === ']')) {
        stack.pop();
        if (stack.length === 0 && start >= 0) {
          const candidate = text.slice(start, i + 1);
          if (candidate.includes('"tool"')) out.push(candidate);
          start = -1;
        }
      } else {
        stack.length = 0;
        start = -1;
      }
    }
  }
  return out;
}

/** 把未知的 JSON 值归一成 ToolCall（tool 非字符串或 input 缺失时容错）。 */
function coerceToolCall(item: unknown): ToolCall {
  const o = (item ?? {}) as { tool?: unknown; input?: unknown };
  return {
    tool: typeof o.tool === 'string' ? o.tool : '',
    input: (o.input ?? {}) as Record<string, unknown>,
  };
}