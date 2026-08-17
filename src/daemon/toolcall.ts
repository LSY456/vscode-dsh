/**
 * 模型工具调用约定（P3.2）：助手在正文中输出一个 fenced JSON 块。
 *
 *    ```toolcall
 *    {"tool":"read_file","input":{"path":"/abs/path"}}
 *    ```
 *
 * 支持单个对象或对象数组；解析失败的行块被忽略（非致命）。该约定同时被
 * realAgent.ts（解析）与 model.ts 的 FakeChatModel（生成）使用。
 */

export interface ToolCall {
  tool: string;
  input: Record<string, unknown>;
}

export const TOOLCALL_FENCE = 'toolcall';

export function formatToolCall(call: ToolCall): string {
  return '```' + TOOLCALL_FENCE + '\n' + JSON.stringify(call) + '\n```\n';
}

export function parseToolCalls(text: string): ToolCall[] {
  const out: ToolCall[] = [];
  const re = new RegExp('```' + TOOLCALL_FENCE + '\\s*\\n([\\s\\S]*?)\\n```', 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(m[1].trim());
      if (Array.isArray(parsed)) {
        for (const item of parsed) out.push(normalize(item));
      } else {
        out.push(normalize(parsed));
      }
    } catch {
      /* 忽略无法解析的块 */
    }
  }
  return out;
}

function normalize(item: unknown): ToolCall {
  const o = (item ?? {}) as { tool?: unknown; input?: unknown };
  return {
    tool: typeof o.tool === 'string' ? o.tool : '',
    input: (o.input ?? {}) as Record<string, unknown>,
  };
}