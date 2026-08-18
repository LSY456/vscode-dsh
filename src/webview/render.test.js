// @vitest-environment jsdom
/**
 * Webview Markdown 渲染（A1）行为与安全测试。
 * 安全断言目标：任何恶意输入在 renderMarkdown / sanitizeHtml 后，
 * 不得包含可执行形态（script / 事件属性 / javascript: 链接）。
 */
import { describe, expect, it } from 'vitest';
import { escapeHtml, renderMarkdown, sanitizeHtml } from './render.js';

describe('renderMarkdown：基础渲染', () => {
  it('标题与段落', () => {
    const html = renderMarkdown('# 标题\n\n正文段落');
    expect(html).toContain('<h1>标题</h1>');
    expect(html).toContain('<p>正文段落</p>');
  });

  it('链接保留（http/https/mailto）', () => {
    const html = renderMarkdown('[仓库](https://github.com/LSY456/vscode-dsh.git)');
    expect(html).toContain('<a href="https://github.com/LSY456/vscode-dsh.git">仓库</a>');
  });

  it('GFM 表格', () => {
    const html = renderMarkdown('| a | b |\n| - | - |\n| 1 | 2 |');
    expect(html).toContain('<table>');
    expect(html).toContain('1');
  });

  it('行内代码转义为文本', () => {
    const html = renderMarkdown('执行 `node run.js`');
    expect(html).toContain('<code>node run.js</code>');
  });

  it('纯文本原样输出', () => {
    expect(renderMarkdown('普通文本')).toContain('普通文本');
  });
});

describe('renderMarkdown：代码块高亮与转义', () => {
  it('fenced 代码块渲染为 <pre><code class="hljs">', () => {
    const html = renderMarkdown('```js\nconst x = 1;\n```');
    expect(html).toContain('<pre><code class="hljs language-js">');
    // hljs 输出含 HTML 标签会打断文本，只验证关键内容词存在
    expect(html).toContain('const');
    expect(html).toContain('class="hljs-number"');
    expect(html).toContain('1');
  });

  it('代码块内的 <script> 必须作为文本转义呈现，绝不产生可执行标签', () => {
    const html = renderMarkdown('```html\n<script>alert(1)</script>\n```');
    expect(html).not.toMatch(/<script/i);
    // hljs 转义后必然包含 &lt; 或 &amp;lt;
    expect(html).toContain('&lt;');
  });

  it('未知语言代码块同样转义', () => {
    const html = renderMarkdown('```unknownlang\n<img src=x onerror=alert(1)>\n```');
    expect(html).not.toMatch(/<img/i);
    expect(html).toContain('&lt;');
  });
});

describe('renderMarkdown：XSS 净化（关键安全断言）', () => {
  const DANGEROUS = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<svg onload=alert(1)>',
    '[点我](javascript:alert(1))',
    '<iframe src="https://evil.example"></iframe>',
    '<a href="javascript:alert(1)">x</a>',
  ];
  for (const payload of DANGEROUS) {
    it(`剥离危险输入：${payload.slice(0, 40)}`, () => {
      const html = renderMarkdown(payload);
      expect(html).not.toMatch(/<script/i);
      expect(html).not.toMatch(/onerror|onload|onclick/i);
      expect(html).not.toMatch(/javascript:/i);
      expect(html).not.toMatch(/<iframe/i);
      expect(html).not.toMatch(/<svg/i);
    });
  }

  it('净化后不影响正常内容', () => {
    const html = renderMarkdown('# 安全标题\n\n**加粗**文本');
    expect(html).toContain('<h1>安全标题</h1>');
    expect(html).toContain('<strong>加粗</strong>');
  });
});

describe('sanitizeHtml：统一净化入口', () => {
  it('剥离脚本与事件属性，保留安全标签', () => {
    const html = sanitizeHtml('<p onclick="x()">ok</p><script>bad()</script>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onclick');
    expect(html).toContain('ok');
  });
});

describe('escapeHtml', () => {
  it('转义 < > & " \'', () => {
    expect(escapeHtml(`<a href="x"&'y'>`)).toBe(
      '&lt;a href=&quot;x&quot;&amp;&#39;y&#39;&gt;'
    );
  });
});