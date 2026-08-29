import { describe, it, expect } from 'vitest';
import { parseToolCalls, formatToolCall } from './toolcall';

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