/**
 * webview HTML 渲染契约（回归自"界面完全没有样式"那次故障）。
 *
 * 背景：webview 里 **脚本靠 nonce 放行、样式只能靠 CSP 的 URL 匹配放行**。
 * 样式一旦走外部资源 URI，就要拿带百分号编码盘符的路径（形如 `/c%3A/Users/...`）
 * 去参与 CSP 匹配；匹配不成立时被 `default-src 'none'` 整条拦掉，
 * 而脚本照常运行 —— 症状是"功能全在、界面退化成浏览器默认样式"，
 * 排查时极易误判成"改的 CSS 没生效"。因此这里把"样式怎么进 webview"钉死为内联 + nonce。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderWebviewHtml } from './webviewHtml';

// 测试以仓库根为 cwd 运行（`npm test`），直接读真实的模板而不是自带副本 ——
// 这样模板里改了占位符、忘了同步渲染逻辑，这里立刻会红。
const template = readFileSync(path.join(process.cwd(), 'media', 'webview.html'), 'utf8');

const PARTS = {
  nonce: 'nonce-abc123',
  css: ':root { --dsh-role-col: 20px; }\nbody { color: red; }',
  cspSource: 'https://file+.vscode-resource.vscode-cdn.net',
  jsUri: 'https://file+.vscode-resource.vscode-cdn.net/c%3A/x/out/media/webview.js?v=deadbeef',
};

/** 取出 CSP meta 的 content 值 */
function cspOf(html: string): string {
  const m = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/);
  if (!m) throw new Error('未找到 CSP meta');
  return m[1];
}

describe('renderWebviewHtml', () => {
  it('真实模板渲染后不残留任何占位符', () => {
    const html = renderWebviewHtml(template, PARTS);
    for (const p of ['__NONCE__', '__CSS__', '__CSP_SOURCE__', '__JS_URI__']) {
      expect(html).not.toContain(p);
    }
    expect(html).not.toContain('<!--'); // 注释是写给模板读者的，不进运行时产物
    expect(html).toContain('<title>dsh Agent</title>');
  });

  it('样式内联进带 nonce 的 <style>，不再引用外部样式表', () => {
    const html = renderWebviewHtml(template, PARTS);
    expect(html).not.toMatch(/<link[^>]*rel="stylesheet"/);
    expect(html).toContain(`<style nonce="${PARTS.nonce}">`);
    expect(html).toContain(PARTS.css);
  });

  it('CSP：style-src 用 nonce 放行内联样式，且不再把资源 URI 塞进去', () => {
    const csp = cspOf(renderWebviewHtml(template, PARTS));
    expect(csp).toContain(`style-src 'nonce-${PARTS.nonce}'`);
    expect(csp).toContain(PARTS.cspSource);
    expect(csp).toContain(`script-src 'nonce-${PARTS.nonce}'`);
    expect(csp).toContain("default-src 'none'");
    // 关键：CSP 里不许再出现带路径/查询的资源 URI（那正是被拦的原因）
    expect(csp).not.toContain('webview.css');
    expect(csp).not.toContain('%3A');
  });

  it('脚本仍走资源 URI，并原样带上内容指纹', () => {
    const html = renderWebviewHtml(template, PARTS);
    expect(html).toContain(`src="${PARTS.jsUri}"`);
    expect(html).toContain(`nonce="${PARTS.nonce}"`);
  });

  it('CSS 正文里的 </style 被转义，不会提前闭合 style 标签', () => {
    const html = renderWebviewHtml(template, { ...PARTS, css: '/* </style><script>x</script> */' });
    expect(html).not.toContain('</style><script>');
    expect(html).toContain('<\\/style>');
  });

  it('模板里有没被替换的占位符（新增忘同步 / 名字拼错）时抛错，而不是静默渲染出无样式的界面', () => {
    expect(() =>
      renderWebviewHtml('<style nonce="__NONCE__">__CSS__</style><b>__CSSS__</b>', PARTS)
    ).toThrow(/__CSSS__/);
  });

  it('注释里提到的占位符名字不算漏替换（注释不进运行时产物）', () => {
    expect(() =>
      renderWebviewHtml('<!-- 说明：__CSS__ 由调用方注入 --><i>__NONCE__</i>', PARTS)
    ).not.toThrow();
  });
});
