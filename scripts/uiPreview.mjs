/**
 * 生成 dsh Agent 面板的静态 UI 预览。
 *
 * 为什么需要它：面板只在 VSCode webview 里渲染，改完 CSS/布局无法直接"看一眼"。
 * 这里用 jsdom 载入**真实的** media/webview.html + media/webview.js，按真实事件流
 * （与 daemon 推的一模一样）把界面渲染出来，再导出成静态 HTML 供浏览器查看——
 * 因此预览里的 DOM 结构与线上完全一致，只是数据是假的。
 *
 * 用法：node scripts/uiPreview.mjs
 * 产物：scripts/ui-preview.html
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const here = fileURLToPath(new URL('.', import.meta.url));
const media = (name) => readFileSync(new URL(`../media/${name}`, import.meta.url), 'utf8');

// ---- 面板骨架：与 webviewPanel 注入时同样的剥离方式（去 script，留 body 内容）----
const rawHtml = media('webview.html');
const BODY_HTML = rawHtml
  .slice(rawHtml.indexOf('<body>') + '<body>'.length, rawHtml.lastIndexOf('</body>'))
  .replace(/<script[\s\S]*?<\/script>/g, '');
const PANEL_CSS = media('webview.css');

/**
 * 用真实 UI 代码渲染一个场景，返回渲染后的 body innerHTML。
 * 每个场景独立 JSDOM + 独立模块实例（query 串绕过 ESM 缓存），互不串状态。
 */
let seq = 0;
async function renderScenario(script) {
  seq += 1;
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${BODY_HTML}</body></html>`, {
    pretendToBeVisual: true,
  });
  const { window } = dom;
  // webview.js 通过裸全局访问这些名字（真实运行时由 VSCode 注入）
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.MessageEvent = window.MessageEvent;
  globalThis.KeyboardEvent = window.KeyboardEvent;
  globalThis.acquireVsCodeApi = () => ({ postMessage() {} });

  await import(`${new URL('../media/webview.js', import.meta.url).href}?scenario=${seq}`);

  const emit = (method, params) =>
    window.dispatchEvent(new window.MessageEvent('message', { data: { kind: 'event', method, params } }));
  const emitRaw = (data) =>
    window.dispatchEvent(new window.MessageEvent('message', { data }));

  script({ emit, emitRaw });
  return window.document.body.innerHTML;
}

// ---- 主题变量：让预览看起来就是 VSCode 的浅色 / 深色主题 ----
const LIGHT = {
  'vscode-foreground': '#3b3b3b',
  'vscode-descriptionForeground': '#717171',
  'vscode-sideBar-background': '#f8f8f8',
  'vscode-editor-background': '#ffffff',
  'vscode-editorWidget-background': '#f8f8f8',
  'vscode-panel-border': '#e5e5e5',
  'vscode-editorWidget-border': '#e5e5e5',
  'vscode-button-background': '#005fb8',
  'vscode-button-foreground': '#ffffff',
  'vscode-button-secondaryBackground': '#e9e9e9',
  'vscode-focusBorder': '#005fb8',
  'vscode-textLink-foreground': '#005fb8',
  'vscode-input-background': '#ffffff',
  'vscode-input-foreground': '#3b3b3b',
  'vscode-input-border': '#cecece',
  'vscode-input-placeholderForeground': '#9d9d9d',
  'vscode-inputOption-activeBackground': '#e8f0fb',
  'vscode-inputOption-activeBorder': '#b6d3f2',
  'vscode-toolbar-hoverBackground': 'rgba(0,0,0,0.06)',
  'vscode-list-hoverBackground': 'rgba(0,0,0,0.04)',
  'vscode-textCodeBlock-background': '#f6f6f6',
  'vscode-scrollbarSlider-background': 'rgba(100,100,100,0.25)',
  'vscode-scrollbarSlider-hoverBackground': 'rgba(100,100,100,0.45)',
  'vscode-badge-background': '#c4c4c4',
  'vscode-badge-foreground': '#333333',
  'vscode-editorWarning-foreground': '#bf8803',
  'vscode-editorError-foreground': '#e51400',
  'vscode-testing-iconPassed': '#1a7f37',
  'vscode-charts-yellow': '#bf8803',
  'vscode-charts-red': '#e51400',
  'vscode-charts-green': '#1a7f37',
  'vscode-inputValidation-warningBackground': '#fff4e5',
  'vscode-inputValidation-errorBackground': '#fdeaea',
  'vscode-symbolIcon-keywordForeground': '#0000ff',
  'vscode-symbolIcon-stringForeground': '#a31515',
  'vscode-symbolIcon-numberForeground': '#098658',
  'vscode-symbolIcon-functionForeground': '#795e26',
  'vscode-symbolIcon-methodForeground': '#267f99',
  'vscode-editor-foreground': '#3b3b3b',
  'vscode-editor-font-family': 'Consolas, "Cascadia Mono", monospace',
  'vscode-editor-font-size': '12px',
  'vscode-font-family': '"Segoe UI", system-ui, "Microsoft YaHei", sans-serif',
  'vscode-font-size': '13px',
};

const DARK = {
  'vscode-foreground': '#cccccc',
  'vscode-descriptionForeground': '#9d9d9d',
  'vscode-sideBar-background': '#1f1f1f',
  'vscode-editor-background': '#1f1f1f',
  'vscode-editorWidget-background': '#202020',
  'vscode-panel-border': '#2b2b2b',
  'vscode-editorWidget-border': '#313131',
  'vscode-button-background': '#0078d4',
  'vscode-button-foreground': '#ffffff',
  'vscode-button-secondaryBackground': '#313131',
  'vscode-focusBorder': '#0078d4',
  'vscode-textLink-foreground': '#4daafc',
  'vscode-input-background': '#313131',
  'vscode-input-foreground': '#cccccc',
  'vscode-input-border': '#3c3c3c',
  'vscode-input-placeholderForeground': '#989898',
  'vscode-inputOption-activeBackground': 'rgba(36,137,227,0.12)',
  'vscode-inputOption-activeBorder': '#0078d4',
  'vscode-toolbar-hoverBackground': 'rgba(90,93,94,0.31)',
  'vscode-list-hoverBackground': 'rgba(255,255,255,0.06)',
  'vscode-textCodeBlock-background': '#2b2b2b',
  'vscode-scrollbarSlider-background': 'rgba(121,121,121,0.4)',
  'vscode-scrollbarSlider-hoverBackground': 'rgba(121,121,121,0.7)',
  'vscode-badge-background': '#616161',
  'vscode-badge-foreground': '#f8f8f8',
  'vscode-editorWarning-foreground': '#cca700',
  'vscode-editorError-foreground': '#f14c4c',
  'vscode-testing-iconPassed': '#73c991',
  'vscode-charts-yellow': '#cca700',
  'vscode-charts-red': '#f14c4c',
  'vscode-charts-green': '#89d185',
  'vscode-inputValidation-warningBackground': '#352a05',
  'vscode-inputValidation-errorBackground': '#5a1d1d',
  'vscode-symbolIcon-keywordForeground': '#569cd6',
  'vscode-symbolIcon-stringForeground': '#ce9178',
  'vscode-symbolIcon-numberForeground': '#b5cea8',
  'vscode-symbolIcon-functionForeground': '#dcdcaa',
  'vscode-symbolIcon-methodForeground': '#4ec9b0',
  'vscode-editor-foreground': '#d4d4d4',
  'vscode-editor-font-family': 'Consolas, "Cascadia Mono", monospace',
  'vscode-editor-font-size': '12px',
  'vscode-font-family': '"Segoe UI", system-ui, "Microsoft YaHei", sans-serif',
  'vscode-font-size': '13px',
};

const themeCss = (vars) =>
  ':root{\n' + Object.entries(vars).map(([k, v]) => `  --${k}: ${v};`).join('\n') + '\n}\n';

// ---- 场景一：完整对话（挂起项 + 过程 + 推理 + 卡片 + 报错，一次看全）----
const EXPIRES = 30 * 60 * 1000; // 预览里倒计时真实走动，30 分钟足够看完

const conversationDom = await renderScenario(({ emit, emitRaw }) => {
  emitRaw({
    kind: 'init',
    state: {
      sessionId: 'sess_preview_9f3a1c7e',
      connected: true,
      agent: 'real',
      model: 'deepseek-flash',
      history: [],
    },
  });
  emitRaw({ kind: 'session.reset', sessionId: 'sess_preview_9f3a1c7e', reason: 'new' });
  emit('session.started', { sessionId: 'sess_preview_9f3a1c7e', title: '给 tools.ts 补路径护栏' });
  // 状态行的余额 chip（扩展本地事件；文案由 src/accountBalance.ts 统一组装）
  emit('balance.info', {
    available: true,
    text: '余额 ¥110.00',
    title: 'API 余额 ¥110.00｜赠金 10.00 · 充值 100.00｜更新于 22:50:01｜点击刷新',
    insufficient: false,
  });

  emit('user.message', {
    text: '看下 `src/daemon/tools.ts` 的 `resolveInWorkspace`，**越界路径**处理得对吗？',
    attachments: [{ label: 'tools.ts' }, { label: '选区 L42-88' }, { label: '2 个诊断' }],
  });

  emit('reasoning.delta', {
    delta: '先读 resolveInWorkspace 的实现，再核对它有没有在 realpath 之后重新比对前缀……',
  });

  emit('tool.started', { tool: 'read_file', input: { path: 'src/daemon/tools.ts', startLine: 42, endLine: 88 } });
  emit('tool.executed', { tool: 'read_file', ok: true, output: '(文件内容略)', durationMs: 18 });
  emit('tool.started', { tool: 'grep', input: { pattern: 'realpath', path: 'src/daemon' } });
  emit('tool.executed', {
    tool: 'grep',
    ok: false,
    output: '未匹配到 realpath —— 说明没有做符号链接解析',
    durationMs: 7,
  });

  emit('message.delta', { delta: '## 结论\n\n`resolveInWorkspace` 只做了**字符串前缀比较**，没有解析符号链接：\n\n' });
  emit('message.delta', { delta: '```ts\nif (!resolved.startsWith(root)) {\n  throw new Error("越界路径");\n}\n```\n\n' });
  emit('message.delta', {
    delta:
      '工作区里若存在指向外部的软链接，`link/secret.txt` 会被判为合法路径。\n\n| 检查项 | 现状 |\n|---|---|\n| 前缀比较 | ✅ 已做 |\n| 符号链接 | ❌ 缺失 |\n\n建议在比对前补一次 `fs.realpath`。',
  });
  emit('message.done', {});

  emit('trajectory.record', { step: 1, kind: 'tool', detail: 'read_file src/daemon/tools.ts' });
  emit('trajectory.record', { step: 2, kind: 'tool', detail: 'grep realpath src/daemon' });

  emit('approval.request', {
    approvalId: 'ap_preview',
    tool: 'bash_execute',
    input: { command: 'npm test -- tools' },
    risk: 'high',
    reason: '执行测试会启动子进程，需你确认',
    expiresAt: Date.now() + EXPIRES,
  });
  emit('file.patch.pending', {
    patchId: 'pt_preview',
    path: 'src/daemon/tools.ts',
    oldContent: 'a',
    newContent: 'b',
    description: '补上 realpath 解析后的前缀二次校验',
    expiresAt: Date.now() + EXPIRES,
  });

  emit('error', { message: '示例：一次工具调用被沙箱拒绝（仅为展示错误态样式）' });
  emit('session.ended', { reason: 'completed' });
});

// ---- 场景二：空态 + 演示模式横幅（未配置 Key 的显式提示）----
const emptyDom = await renderScenario(({ emitRaw }) => {
  emitRaw({
    kind: 'init',
    state: {
      sessionId: '',
      connected: true,
      agent: 'mock',
      agentReason: 'no-api-key',
      model: 'deepseek-flash',
      history: [],
    },
  });
});

// ---- 场景三：已决策的审批 / 补丁卡（折叠态：只留标题行 + 结论徽标）----
// 决策走真实点击路径（decideApproval / decidePatch），而不是直接改 DOM——
// 这样预览里看到的折叠效果与线上完全同源。
const decidedDom = await renderScenario(({ emit, emitRaw }) => {
  emitRaw({
    kind: 'init',
    state: {
      sessionId: 'sess_preview_decided',
      connected: true,
      agent: 'real',
      model: 'deepseek-flash',
      history: [],
    },
  });
  emitRaw({ kind: 'session.reset', sessionId: 'sess_preview_decided', reason: 'new' });

  emit('approval.request', {
    approvalId: 'ap_decided_reject',
    tool: 'bash_execute',
    input: { command: 'rm -rf build' },
    risk: 'high',
    reason: '高危命令需人工审批',
  });
  emit('approval.request', {
    approvalId: 'ap_decided_trust',
    tool: 'read_file',
    input: { path: 'src/daemon/tools.ts' },
    risk: 'low',
    reason: '读取工作区内的文件',
  });
  emit('file.patch.pending', {
    patchId: 'pt_decided',
    path: 'src/daemon/tools.ts',
    oldContent: 'a',
    newContent: 'b',
    description: '补上 realpath 解析后的前缀二次校验',
  });

  // 待办条一次只投影一个挂起项，所以按当前显示的按钮逐个点
  const doc = globalThis.document;
  const click = (label) => {
    const b = [...doc.querySelectorAll('#pending-actions button')].find((n) => n.textContent === label);
    if (!b) throw new Error('[uiPreview] 待办条上没有按钮：' + label);
    b.click();
  };
  click('拒绝'); // ap_decided_reject → 已拒绝
  click('接受并记住'); // ap_decided_trust → 已接受并记住
  click('应用'); // pt_decided → 已提交，等待应用
  emit('file.patch.result', { patchId: 'pt_decided', accepted: true, applied: true });
});

// ---- 场景四：点「新建会话」后空态回来（用户报的"新页面一片空白"）----
// 关键差别：这里先有一轮对话，再走真正的 session.reset(new)。
// 旧实现里紧随其后的「已新建会话：sess_xxx」系统行会把空态顶掉，新页面只剩一行会话号。
const newSessionDom = await renderScenario(({ emit, emitRaw }) => {
  emitRaw({
    kind: 'init',
    state: {
      sessionId: 'sess_preview_before',
      connected: true,
      agent: 'real',
      model: 'deepseek-flash',
      history: [],
    },
  });
  emit('user.message', { text: '上一轮问的问题', attachments: [{ label: 'tools.ts' }] });
  emit('message.delta', { delta: '上一轮的回答。' });
  emit('message.done', {});
  emitRaw({ kind: 'session.reset', sessionId: 'sess_preview_after', reason: 'new' });
});

// ---- 场景五：受限模式（工作区未被信任，P0-1 安全门禁）----
// 未信任时 daemon **不启动**，所以这块 UI 必须自己说清「为什么不能用 + 点哪里能解除」。
// trust 载荷与 src/workspaceTrust.ts 的 resolveTrustGate 保持一致（那份是 .ts，预览侧只能内联）。
const restrictedDom = await renderScenario(({ emitRaw }) => {
  emitRaw({
    kind: 'init',
    state: {
      sessionId: '',
      connected: false,
      history: [],
      trust: {
        blocked: true,
        statusLabel: '受限模式',
        statusDetail:
          '当前工作区未被信任（受限模式），Agent 未启动：它需要读写工作区文件、执行命令，' +
          '并在 .dsh/ 下写入会话记录。信任此工作区后即可正常使用。',
        banner: {
          tag: '受限模式',
          text:
            '当前工作区未被信任，Agent 未启动 —— 它需要读写工作区文件、执行命令，' +
            '并在 .dsh/ 下写入会话记录。',
          actionLabel: '信任此工作区',
        },
      },
    },
  });
  emitRaw({
    kind: 'status',
    status: 'restricted',
    detail: '当前工作区未被信任（受限模式），Agent 未启动：它需要读写工作区文件、执行命令。',
  });
});

// ---- 场景七：模型设置（模型名走下拉，并说清列表从哪来）----
// 模型名是"外部事实"：手写容易错，官方改名用户也不会知道（`deepseek-chat` 已于
// 2026/07/24 弃用）。所以模型名只提供下拉选择；列表来源与失败原因由扩展算好后
// 经 modelsHint 下发（面板打开时先用缓存/内置快照渲染，在线列表随后以
// settings.models 事件补上）。这里画的是"在线列表已回来"的最终态。
const settingsDom = await renderScenario(({ emitRaw }) => {
  emitRaw({
    kind: 'init',
    state: {
      sessionId: 'sess_preview_settings',
      connected: true,
      agent: 'real',
      model: 'deepseek-flash',
      history: [],
    },
  });
  globalThis.document.getElementById('btn-settings').click();
  emitRaw({
    kind: 'event',
    method: 'settings.loaded',
    params: {
      config: {
        baseURL: 'https://api.deepseek.com/v1',
        model: 'deepseek-flash',
        preset: 'default',
        provider: 'auto',
        // Agent 预算（此前的"死配置"）：面板里可改、可留空，留空即不修改
        maxToolRounds: 8,
        maxContextTokens: 49152,
      },
      hasApiKey: true,
      models: [
        { id: 'deepseek-flash', label: 'deepseek-flash（快速 · 1M）', source: 'live' },
        { id: 'deepseek-v4-pro', label: 'deepseek-v4-pro（强推理）', source: 'live' },
      ],
      modelsHint: '已从 api.deepseek.com 在线更新模型列表（2 个可选）',
    },
  });
});

// ---- 组装预览页 ----
const esc = (s) => s.replace(/<\/(script)/gi, '<\\/$1');

const preview = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<title>dsh Agent 面板 · UI 预览</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; padding: 24px 28px 40px;
    background: #17171b; color: #e6e6e6;
    font: 13px/1.6 "Segoe UI", system-ui, "Microsoft YaHei", sans-serif;
  }
  h1 { font-size: 17px; margin: 0 0 6px; font-weight: 600; }
  .sub { color: #9a9aa4; font-size: 12px; margin-bottom: 22px; max-width: 980px; }
  .sub code { background: #26262c; padding: 1px 5px; border-radius: 4px; }
  .row { display: flex; gap: 24px; flex-wrap: wrap; align-items: flex-start; }
  figure { margin: 0; }
  figcaption { font-size: 11px; color: #9a9aa4; margin-bottom: 8px; letter-spacing: 0.02em; }
  .frame {
    border: 1px solid #33333b; border-radius: 10px; overflow: hidden;
    background: #fff; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  }
  .frame.narrow { width: 340px; height: 700px; }
  .frame.wide { width: 760px; height: 700px; }
  iframe { width: 100%; height: 100%; border: 0; display: block; }
</style>
</head>
<body>
  <h1>dsh Agent 面板 · UI 预览</h1>
  <div class="sub">
    由 <code>node scripts/uiPreview.mjs</code> 用**真实**的 <code>media/webview.html</code> +
    <code>media/webview.js</code> 渲染，DOM 与线上一致，数据为示例。倒计时是真实走动的。
  </div>
  <div class="row">
    <figure>
      <figcaption>① 侧边栏 340px · 完整对话（浅色主题）</figcaption>
      <div class="frame narrow"><iframe id="f-narrow-light"></iframe></div>
    </figure>
    <figure>
      <figcaption>② 编辑器列 760px · 完整对话（浅色主题）</figcaption>
      <div class="frame wide"><iframe id="f-wide-light"></iframe></div>
    </figure>
    <figure>
      <figcaption>③ 侧边栏 340px · 空态 + 演示模式（深色主题）</figcaption>
      <div class="frame narrow"><iframe id="f-narrow-dark"></iframe></div>
    </figure>
    <figure>
      <figcaption>④ 侧边栏 340px · 已决策卡片折叠态（浅色主题，点标题可再展开）</figcaption>
      <div class="frame narrow"><iframe id="f-narrow-decided"></iframe></div>
    </figure>
    <figure>
      <figcaption>⑤ 侧边栏 340px · 点「新建会话」后回到空态（浅色主题）</figcaption>
      <div class="frame narrow"><iframe id="f-narrow-newsession"></iframe></div>
    </figure>
    <figure>
      <figcaption>⑥ 侧边栏 340px · 受限模式：工作区未被信任，daemon 未启动（浅色主题）</figcaption>
      <div class="frame narrow"><iframe id="f-narrow-restricted"></iframe></div>
    </figure>
    <figure>
      <figcaption>⑦ 侧边栏 340px · 模型设置：模型名下拉 + 列表来源说明（浅色主题）</figcaption>
      <div class="frame narrow"><iframe id="f-narrow-settings"></iframe></div>
    </figure>
  </div>

<script type="text/plain" id="panel-css">${esc(PANEL_CSS)}</script>
<script type="text/plain" id="theme-light">${esc(themeCss(LIGHT))}</script>
<script type="text/plain" id="theme-dark">${esc(themeCss(DARK))}</script>
<script type="text/plain" id="dom-conversation">${esc(conversationDom)}</script>
<script type="text/plain" id="dom-empty">${esc(emptyDom)}</script>
<script type="text/plain" id="dom-decided">${esc(decidedDom)}</script>
<script type="text/plain" id="dom-newsession">${esc(newSessionDom)}</script>
<script type="text/plain" id="dom-restricted">${esc(restrictedDom)}</script>
<script type="text/plain" id="dom-settings">${esc(settingsDom)}</script>
<script>
  const txt = (id) => document.getElementById(id).textContent;
  const panelCss = txt('panel-css');
  const build = (domHtml, themeId) =>
    '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
    txt(themeId) + panelCss +
    '</style></head><body>' + domHtml + '</body></html>';
  const conv = txt('dom-conversation');
  const empty = txt('dom-empty');
  const decided = txt('dom-decided');
  const newsession = txt('dom-newsession');
  const restricted = txt('dom-restricted');
  const settings = txt('dom-settings');
  document.getElementById('f-narrow-light').srcdoc = build(conv, 'theme-light');
  document.getElementById('f-wide-light').srcdoc = build(conv, 'theme-light');
  document.getElementById('f-narrow-dark').srcdoc = build(empty, 'theme-dark');
  document.getElementById('f-narrow-decided').srcdoc = build(decided, 'theme-light');
  document.getElementById('f-narrow-newsession').srcdoc = build(newsession, 'theme-light');
  document.getElementById('f-narrow-restricted').srcdoc = build(restricted, 'theme-light');
  document.getElementById('f-narrow-settings').srcdoc = build(settings, 'theme-light');
</script>
</body>
</html>
`;

writeFileSync(new URL('./ui-preview.html', import.meta.url), preview, 'utf8');
console.log(`[uiPreview] 已生成 scripts/ui-preview.html（${(preview.length / 1024).toFixed(1)} KB）`);
process.exit(0);
