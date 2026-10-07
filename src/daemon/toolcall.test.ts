import { describe, it, expect } from 'vitest';
import { createToolCallFenceFilter, parseToolCalls, formatToolCall } from './toolcall';

describe('parseToolCalls 真实场景容错', () => {
  it('解析标准 ```toolcall fenced 单对象（向后兼容）', () => {
    const text = '```toolcall\n{"tool":"read_file","input":{"path":"/a/b.txt"}}\n```';
    expect(parseToolCalls(text)).toEqual([{ tool: 'read_file', input: { path: '/a/b.txt' } }]);
  });

  it('解析 ```json fenced（真实模型语言标签漂移）', () => {
    const text = '```json\n{"tool":"list_dir","input":{"path":"."}}\n```';
    expect(parseToolCalls(text)).toEqual([{ tool: 'list_dir', input: { path: '.' } }]);
  });

  it('解析无语言标签的 fenced 块', () => {
    const text = '```\n{"tool":"write_file","input":{"path":"/a","content":"x"}}\n```';
    expect(parseToolCalls(text)).toEqual([{ tool: 'write_file', input: { path: '/a', content: 'x' } }]);
  });

  it('未知语言标签 fenced 块内的工具 JSON 经裸 JSON 兜底仍可解析', () => {
    const text = '```python\n{"tool":"read_file","input":{"path":"/a"}}\n```';
    expect(parseToolCalls(text)).toEqual([{ tool: 'read_file', input: { path: '/a' } }]);
  });

  it('解析 fenced 数组（一次多个工具调用）', () => {
    const text = '```toolcall\n[{"tool":"read_file","input":{"path":"/a"}},{"tool":"list_dir","input":{"path":"/"}}]\n```';
    expect(parseToolCalls(text)).toEqual([
      { tool: 'read_file', input: { path: '/a' } },
      { tool: 'list_dir', input: { path: '/' } },
    ]);
  });

  it('解析「先解释再调用」的正文（模型附带说明文字）', () => {
    const text = '我先读取该文件的内容。\n\n```toolcall\n{"tool":"read_file","input":{"path":"/src/x.ts"}}\n```';
    expect(parseToolCalls(text)).toEqual([{ tool: 'read_file', input: { path: '/src/x.ts' } }]);
  });

  it('解析同一输出中的多个 fenced 块', () => {
    const text =
      '```toolcall\n{"tool":"read_file","input":{"path":"/a"}}\n```\n继续看目录。\n```json\n{"tool":"list_dir","input":{"path":"/src"}}\n```';
    expect(parseToolCalls(text)).toEqual([
      { tool: 'read_file', input: { path: '/a' } },
      { tool: 'list_dir', input: { path: '/src' } },
    ]);
  });

  it('无 fence 时兜底解析裸 JSON 对象（真实模型直接输出）', () => {
    const text = '{"tool":"read_file","input":{"path":"/bare.json"}}';
    expect(parseToolCalls(text)).toEqual([{ tool: 'read_file', input: { path: '/bare.json' } }]);
  });

  it('无 fence 时兜底解析裸 JSON 数组', () => {
    const text = '[{"tool":"list_dir","input":{"path":"."}},{"tool":"read_file","input":{"path":"x"}}]';
    expect(parseToolCalls(text)).toEqual([
      { tool: 'list_dir', input: { path: '.' } },
      { tool: 'read_file', input: { path: 'x' } },
    ]);
  });

  it('无 fence 时 input 字符串含花括号不截断（apply_patch 替换代码块）', () => {
    const text = '{"tool":"apply_patch","input":{"path":"/a","search":"b}","replace":"c{"}}';
    expect(parseToolCalls(text)).toEqual([
      { tool: 'apply_patch', input: { path: '/a', search: 'b}', replace: 'c{' } },
    ]);
  });

  it('无 fence 时 input 含转义引号与花括号不截断', () => {
    const text = '{"tool":"bash_execute","input":{"command":"echo \\"a}b\\""}}';
    expect(parseToolCalls(text)).toEqual([{ tool: 'bash_execute', input: { command: 'echo "a}b"' } }]);
  });

  it('普通文本不含工具调用时返回空数组', () => {
    expect(parseToolCalls('这是最终回答，无需工具。')).toEqual([]);
  });

  it('忽略非工具 JSON 代码块（无 tool 字段）', () => {
    const text = '```json\n{"foo":"bar"}\n```';
    expect(parseToolCalls(text)).toEqual([]);
  });

  it('忽略无法解析为 JSON 的块', () => {
    const text = '```toolcall\n{不是 JSON}\n```';
    expect(parseToolCalls(text)).toEqual([]);
  });

  it('formatToolCall 生成仍为 ```toolcall 约定（与 parse 互逆）', () => {
    const call = { tool: 'bash_execute', input: { command: 'npm test' } };
    expect(parseToolCalls(formatToolCall(call))).toEqual([call]);
  });
});

/**
 * 展示层剥离（回归）。
 *
 * 真实缺陷：模型的原始正文里带着工具调用围栏，`realAgent` 把它原样当 `message.delta` 推给面板，
 * 于是每轮调用的原始 JSON 都固化在答案气泡里，还会被扩展写进 `.dsh/history.json`。
 * 剥离必须**精准**：只吞"确实解析成工具调用"的块 —— 请求原文就是给用户看的 JSON 示例、
 * 或代码块里恰好含 `"tool"` 字段的数据，都不能被吞掉。
 */
describe('createToolCallFenceFilter：把工具调用围栏从"给人看的正文"里剥离', () => {
  const BLOCK = '```toolcall\n{"tool":"read_file","input":{"path":"/a"}}\n```';
  const JSON_BLOCK = '```json\n{"tool":"list_dir","input":{"path":"."}}\n```';

  function feed(chunks: string[]): string {
    const filter = createToolCallFenceFilter();
    let out = '';
    for (const c of chunks) out += filter.push(c);
    out += filter.flush();
    return out;
  }
  /** 整块喂入 */
  const single = (text: string) => feed([text]);
  /** 逐字符喂入 —— 最坏情况：围栏必然被切成多段 */
  const byChar = (text: string) => feed([...text]);

  it('正文保留，工具调用块被吞掉且不留空行', () => {
    expect(single(`我先看看目录。\n\n${BLOCK}\n`)).toBe('我先看看目录。\n\n');
  });

  it('增量把围栏切碎也不影响结果（逐字符 == 整块）', () => {
    const text = `我先看看。\n\n${BLOCK}\n然后继续说明。`;
    expect(byChar(text)).toBe('我先看看。\n\n然后继续说明。');
    expect(byChar(text)).toBe(single(text));
  });

  it('```json 形式的工具调用同样被吞掉（模型语言标签会漂移）', () => {
    // 围栏**前面**的换行属于正文段落，保留；围栏**后面**紧跟的换行随块一起吞掉
    expect(single(`看下目录：\n${JSON_BLOCK}\n后面还有正文。`)).toBe('看下目录：\n后面还有正文。');
  });

  it('不含工具调用形状的 ```json 块照常显示（用户可能就是要看这段 JSON）', () => {
    const text = '```json\n{"foo":"bar"}\n```';
    expect(single(text)).toBe(text);
    expect(byChar(text)).toBe(text);
  });

  it('别的语言标签的块一律保留 —— 代码里的 "tool" 字段是数据不是调用', () => {
    const text = '```python\n{"tool":"read_file","input":{"path":"/a"}}\n```';
    expect(single(text)).toBe(text);
  });

  it('未闭合的围栏在流结束时按原样显示（不吞模型的坏输出）', () => {
    const text = '先说明。\n```toolcall\n{"tool":"read_file"';
    expect(single(text)).toBe(text);
  });

  it('多个调用块之间的正文全部保留', () => {
    expect(single(`A\n${BLOCK}\nB\n${JSON_BLOCK}\nC`)).toBe('A\nB\nC');
  });

  it('行内单反引号不被误判为围栏', () => {
    const text = '使用 `code` 标记即可。';
    expect(single(text)).toBe(text);
    expect(byChar(text)).toBe(text);
  });

  it('结尾处不完整的围栏前缀先压住、flush 时再吐出', () => {
    expect(feed(['abc', '`'])).toBe('abc`');
    expect(single('abc`')).toBe('abc`');
  });

  it('整个输出就是一个调用块 -> 展示为空', () => {
    expect(single(BLOCK)).toBe('');
  });

  it('空增量不改变状态', () => {
    expect(feed(['', 'prose', ''])).toBe('prose');
  });
});