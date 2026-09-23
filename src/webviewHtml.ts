/**
 * webview HTML 的占位符渲染。
 *
 * 为什么单独抽成一个纯函数：这段逻辑原先内联在 `WebviewPanel.getHtml()` 里，
 * 而它恰恰是最容易出错、且出错后**症状最难看懂**的地方 ——
 *   - 占位符漏替换 → 标记里留下 `__NONCE__` 之类字面量，样式/脚本静默失效；
 *   - 样式走外部资源 URI → 只能靠 CSP 的 URL 匹配放行，匹配不上就被
 *     `default-src 'none'` 整条拦掉，而脚本因为有 nonce 照常执行。
 * 抽出来之后既不依赖 `vscode` API，也能在单测里直接断言渲染结果的形状。
 *
 * 模板占位符（见 `media/webview.html`）：
 *   __NONCE__       CSP 与 `<style>`/`<script>` 共用的 nonce
 *   __CSS__         内联样式表正文
 *   __CSP_SOURCE__  `webview.cspSource`（不带路径）
 *   __JS_URI__      打包后的 webview.js 资源 URI（带内容指纹）
 */
export interface WebviewHtmlParts {
  nonce: string;
  css: string;
  cspSource: string;
  jsUri: string;
}

export function renderWebviewHtml(template: string, parts: WebviewHtmlParts): string {
  // 先剥掉 HTML 注释再替换：注释是写给人看的（模板里会说明各占位符的用途），
  // 里面出现占位符名字很正常，不该被当成"漏替换"。
  const stripped = template.replace(/<!--[\s\S]*?-->/g, '');

  // CSS 正文里若出现 `</style` 会提前闭合 <style>，把后续标记当 HTML 解析。
  // 转义成 `<\/style`：在 CSS 里无意义（本就属于注释或字符串），但足以阻断闭合。
  const css = parts.css.replace(/<\/style/gi, '<\\/style');

  const html = stripped
    .replace(/__NONCE__/g, parts.nonce)
    .replace(/__CSS__/g, css)
    .replace(/__CSP_SOURCE__/g, parts.cspSource)
    .replace(/__JS_URI__/g, parts.jsUri);

  // 校验以模板里"声明过的占位符"为准：凡是 `__X__` 形状的记号还有残留，
  // 就说明有占位符没被替换 —— 新增占位符忘了同步渲染逻辑、或者名字拼错，都归这类。
  // 后果是静默变丑（没样式）或点了没反应（没脚本），极难归因，所以直接抛错：
  // 宁可让 webview 立刻报错，也不要悄悄退化成不可用的界面。
  const declared = new Set(stripped.match(/__[A-Z0-9_]+__/g) ?? []);
  const leftover = [...declared].filter((p) => html.includes(p));
  if (leftover.length > 0) {
    throw new Error(`webview HTML 渲染后仍残留占位符：${leftover.join('、')}`);
  }
  return html;
}
