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
  /** 原生协议调用 id（OpenAI tool_call.id / Anthropic tool_use.id）；fenced 场景无 */
  id?: string;
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

// ---------------------------------------------------------------------------
// 展示层剥离：把工具调用围栏从「推送给人看的正文」里拿掉
// ---------------------------------------------------------------------------

/**
 * 判定**单个 fenced 块**是否是一次工具调用（块内容 = 围栏之间、含首行语言标签的原文）。
 *
 * 为什么要这么挑：模型按约定把工具调用写在正文里（```toolcall / ```json），而这份正文会被
 * 原样当作 `message.delta` 推给面板 —— 于是每轮工具调用的原始 JSON 都永久留在答案气泡里，
 * 并被写进 `history.json`。删掉它必须**精准**，否则会误伤：
 *  - 明确写了别的语言标签的块（```python / ```bash …）一律保留 —— 里面的 `"tool"` 字段是数据；
 *  - 不含工具调用形状的 JSON 块保留 —— 用户可能就是要求展示一段 JSON；
 *  - 未闭合 / 解析失败的围栏保留 —— 那是模型的坏输出，藏起来等于让人无从诊断。
 */
function isToolCallBlock(raw: string): boolean {
  const nl = raw.indexOf('\n');
  const tag = nl === -1 ? '' : raw.slice(0, nl).trim();
  if (tag !== '' && !FENCE_TAGS.has(tag)) return false;
  return parseBlockToolCalls(raw).length > 0;
}

/** 只在单个块内解析工具调用；与 `parseToolCalls` 的单块路径同源（含裸 JSON 兜底）。 */
function parseBlockToolCalls(raw: string): ToolCall[] {
  const out: ToolCall[] = [];
  const body = stripFenceTag(raw);
  addToolCallsFrom(out, body);
  if (out.length === 0) {
    for (const candidate of extractJsonValues(body)) addToolCallsFrom(out, candidate);
  }
  return out;
}

export interface ToolCallFenceFilter {
  /** 送入一个增量，返回"此刻应当展示"的文本（可能为空串）。 */
  push(chunk: string): string;
  /** 流结束：把仍缓冲的文本按原样吐出；未闭合的围栏一并吐出（不吞模型的坏输出）。 */
  flush(): string;
}

const FENCE = '```';

/** 结尾处不完整的围栏前缀长度（0~2 个反引号）—— 压住它，免得先当正文吐出去。 */
function trailingFencePrefix(buf: string): number {
  let n = 0;
  while (n < 2 && buf[buf.length - 1 - n] === '`') n++;
  return n;
}

/**
 * 流式剥离工具调用围栏。
 *
 * 难点在**增量**：围栏可能恰好被切在两个 chunk 之间（开头 ``` 与闭合 ``` 分属两块），
 * 所以不能对单块做正则替换，只能维护「缓冲 + 游标」：
 *  - 已闭合且判定为工具调用的块 → 吞掉（连紧随的换行一起，免得答案里留空行）；
 *  - 出现未闭合的围栏 → 先压着不吐，等后续增量补齐；
 *  - 其余文本立刻吐出，仅把结尾 1~2 个反引号压住。
 *
 * 仅用于**推送给人看的增量**；回灌给模型的 `content` 必须保持原样 —— 改写模型自己的输出
 * 会让它在下一轮看到一段自己没说过的话。
 */
export function createToolCallFenceFilter(): ToolCallFenceFilter {
  let buf = '';
  let cursor = 0;
  /**
   * 刚吞掉一个块，正等着"下一个非换行字符"。
   *
   * 为什么用标志而不是当场跳过：块尾的换行**可能还没到**（增量正好切在闭合围栏之后），
   * 当场 `while (buf[cursor] === '\n')` 会什么也跳过不了，等这个换行下一批到达时就被当成
   * 正文吐出去 —— 答案里凭空多一个空行。所以把"还在等"记下来，见到换行继续跳、见到非换行才收手。
   */
  let dropLeadingNewline = false;

  const take = (end: number): string => {
    const text = buf.slice(cursor, end);
    cursor = end;
    return text;
  };

  /** 跳过被吞块残留的换行；缓冲区已到末尾时保持标志，等后续增量。 */
  const skipLeadingNewlines = (): void => {
    while (dropLeadingNewline) {
      const ch = buf[cursor];
      if (ch === undefined) return; // 还没到，继续等
      if (ch !== '\n') {
        dropLeadingNewline = false;
        return;
      }
      cursor++;
    }
  };

  const drain = (final: boolean): string => {
    let out = '';
    for (;;) {
      skipLeadingNewlines();
      const open = buf.indexOf(FENCE, cursor);
      if (open === -1) {
        if (final) {
          if (buf.length > cursor) out += take(buf.length);
        } else if (!dropLeadingNewline) {
          const end = buf.length - trailingFencePrefix(buf);
          if (end > cursor) out += take(end);
        }
        return out;
      }
      if (open > cursor) out += take(open);
      const close = buf.indexOf(FENCE, open + FENCE.length);
      if (close === -1) {
        if (final) out += take(buf.length); // 流已结束仍未闭合：照原样展示
        return out;
      }
      const end = close + FENCE.length;
      if (isToolCallBlock(buf.slice(open + FENCE.length, close))) {
        cursor = end;
        dropLeadingNewline = true;
      } else {
        out += take(end);
      }
    }
  };

  return {
    push(chunk) {
      if (!chunk) return '';
      buf += chunk;
      return drain(false);
    },
    flush() {
      const out = drain(true);
      buf = '';
      cursor = 0;
      dropLeadingNewline = false;
      return out;
    },
  };
}