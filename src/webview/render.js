/**
 * Webview Markdown 渲染（A1）。
 *
 * 安全模型（与 webview CSP 双层防御）：
 *  - 解析：marked（GFM）负责 Markdown -> HTML；
 *  - 高亮：highlight.js 核心 + 常用语言，代码内容 HTML 转义后再高亮（代码永远以文本呈现）；
 *  - 净化：DOMPurify 统一清洗输出（剥离 script / 事件属性 / javascript: 等危险形态），
 *    这是唯一允许进入 innerHTML 的入口。
 *
 * 本模块为纯 ESM + 浏览器环境执行（esbuild 内联打包进 webview.js），
 * 不访问 Node 全局；测试在 vitest jsdom 环境运行。
 */
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import markdown from 'highlight.js/lib/languages/markdown';

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('json', json);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('css', css);
hljs.registerLanguage('markdown', markdown);

/** HTML 转义（用于非高亮代码块，保证代码永远以文本呈现）。 */
export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 代码块渲染器（marked v12+ 对象签名：{ text, lang }）。
const renderer = {
  code({ text, lang }) {
    const langClean = String(lang || '').split(/\s+/)[0];
    const known = !!langClean && hljs.getLanguage(langClean) != null;
    let highlighted;
    if (known) {
      try {
        highlighted = hljs.highlight(String(text), { language: langClean, ignoreIllegals: true }).value;
      } catch {
        highlighted = escapeHtml(String(text));
      }
    } else {
      highlighted = escapeHtml(String(text));
    }
    const cls = known ? `hljs language-${langClean}` : 'hljs';
    return `<pre><code class="${cls}">${highlighted}</code></pre>`;
  },
};

marked.use({ renderer });

const DEFAULTS = { gfm: true, breaks: true };

/**
 * 把 Markdown 文本渲染为「已净化」的安全 HTML。唯一允许写入 innerHTML 的入口。
 * 任意输入的 `<script>` / 事件属性 / javascript: 链接都会被剥离。
 */
export function renderMarkdown(md) {
  const raw = marked.parse(md ?? '', DEFAULTS);
  return DOMPurify.sanitize(String(raw), { USE_PROFILES: { html: true } });
}

/** 仅供测试的净化入口（对任意 HTML 做同一套清洗）。 */
export function sanitizeHtml(html) {
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}