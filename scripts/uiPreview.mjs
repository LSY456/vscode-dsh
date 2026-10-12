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
import { Buffer } from 'node:buffer';

/** 见下方 SHOT_PNG_BYTES 的说明；这里内联以免预览脚本依赖外部文件。 */
const SHOT_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAWgAAADcCAIAAADSq6xVAAACzUlEQVR42u3cIQ7CQBBA0Z6kgoRbrEZXY/EcgkNUcSA0p6hENYiGYEkw3WwYutk3eScg9AuYTrc/XQGydD4CQDgA4QCEAxAOQDgAhAMQDkA4AOEAhANAOADhAP4WjmV5AWQRDkA4AOEAthiOeX4CZBEOQDgA4QCEAxAOQDgAhAMQDmAj4bADB1g5B4QDEA6grXDcU4JgHlHhAOEQDhAO4RAOhAPhQDhwAQywcg4IByAcAMIBCAcgHIBwAMIB4AIY4B4HIByAcADCASAcgHAAwgHUHY50vkEwj2j1F8B8iYlnR7P6lXNfYoQD4UA4EA6EA2/HAsIBCAcgHADCAbgABnhXBRAOQDgAhAMQDkA4AOEAhAOg4AIYgJVzQDiADYZjNCZ8PKLCYYxwCIcxwiEcwmGEA+EwwoF/VQAXwAAr54BwAAgHIByAcADCAQgHgHAALoABVs4B4QCEA0A4AOEAhAOoOxzpMkAwj6hwgHC0dwHMl5h4djSrXzn3JUY4EA6EAy+5AcIBCAcgHIBwAAgH4AIY4CU3QDgA4QAQDkA4AOEAhAMQDoCCC2AAVs6B34djNCZ8PKLCYYxwCIcxwiEcwmGEA+EwwoF/VQDhAFwAA6ycAwgHIByAcADCAQgHgHAAwgG4AAZYOQeEA0A4AOEAhAMQDkA4AOEAcAEMsHIOCAcgHIBwAAgHIByAcADCAbgABmDlHBAOQDgA4QCEA2g9HH2/A8giHIBwAMIBCAcgHIBwAAgHIByAcADCAQgHwPpwPA7pk88IKA3HdByAlYRDOEA4hAOEQzhAOPw4Cvg7FhAOQDgAhAMQDkA4AOEAhANAOADhAIQDEA5AOL543xG8HSscIBzCAcIhHCAcfhwFhAMQDgDhAIQDEA5AOADhABAOQDgA4QCEAxAOAOEAhAMQDkA4AOEAhMOnAAgHIByAcADCAQgHgHAAwgEIB1CjNyd09U9GPzqIAAAAAElFTkSuQmCC';
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
 * 一张合成的"报错截图"（360×220 PNG，约 774 字节）。
 *
 * 为什么要造一张真图而不是用 1×1 占位：缩略图是 object-fit: cover 渲染的，
 * 用透明的小图在预览里**看不见**，等于没法验证布局；而且真字节才能顺带把
 * "base64 → 字节数"的换算显示对。
 */
const SHOT_PNG_BYTES = Buffer.from(SHOT_PNG_BASE64, 'base64');

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
  // FileReader 是浏览器内置名，真实 webview 里本来就在（图片附件靠它读字节）。
  // 预览把 webview.js 装进 Node 的全局域运行，所以这些"浏览器给的"名字要一个个搬过来 ——
  // 漏一个的后果不是报错，而是某个功能在预览里静默失效。
  globalThis.FileReader = window.FileReader;
  const posted = [];
  globalThis.acquireVsCodeApi = () => ({
    postMessage(msg) {
      posted.push(msg);
    },
  });

  await import(`${new URL('../media/webview.js', import.meta.url).href}?scenario=${seq}`);

  const emit = (method, params) =>
    window.dispatchEvent(new window.MessageEvent('message', { data: { kind: 'event', method, params } }));
  const emitRaw = (data) =>
    window.dispatchEvent(new window.MessageEvent('message', { data }));

  // 场景可以是 async：暂存图片要等 FileReader，同步回调会截到一个空暂存区
  await script({ emit, emitRaw, posted });
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

  // P2-8：结构化轨迹 —— 成功 / 失败 / token 三种形态各来一条，让徽标排布在同一屏可核对
  emit('trajectory.record', {
    step: 1,
    kind: 'tool',
    detail: 'read_file src/daemon/tools.ts',
    tool: 'read_file',
    ok: true,
    durationMs: 42,
  });
  emit('trajectory.record', {
    step: 2,
    kind: 'tool',
    detail: 'grep realpath src/daemon',
    tool: 'grep',
    ok: true,
    durationMs: 1180,
  });
  emit('trajectory.record', {
    step: 3,
    kind: 'tool',
    detail: 'bash_execute 策略拒绝：命令命中拒绝规则：/\\brm\\s+(-rf|-fr)\\b/i',
    tool: 'bash_execute',
    ok: false,
    durationMs: 3,
    errorKind: 'policy-denied',
  });
  emit('trajectory.record', {
    step: 4,
    kind: 'system',
    detail: 'model 调用（约 3120 token）',
    tokens: { prompt: 2840, completion: 280, total: 3120, estimated: true },
  });

  emit('approval.request', {
    approvalId: 'ap_preview',
    tool: 'bash_execute',
    input: { command: 'npm test -- tools' },
    // P2-9：npm test 属"未列出的命令"，分级按保守兜底记 medium（不再是固定 high）
    risk: 'medium',
    reason: '该命令会写入文件或访问网络，需要人工批准。命令：npm test -- tools',
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
        // 采样参数（批次 2）：null = 用户没配过 → 面板留空，daemon 侧沿用模型层缺省
        temperature: null,
        maxTokens: null,
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

// ---- 场景八：计划模式（P2-7）----
// 一轮"先出方案"的对话：user 气泡带「计划模式」chip、agent 气泡带计划正文、计划卡排在最前。
// 这里一次展示两种状态：先拒掉一份（折叠态：标题行 + 结论徽标），再挂起一份（完整正文 + 补充意见 + 倒计时）。
const planDom = await renderScenario(({ emit, emitRaw }) => {
  emitRaw({
    kind: 'init',
    state: {
      sessionId: 'sess_preview_plan',
      connected: true,
      agent: 'real',
      model: 'deepseek-flash',
      history: [],
    },
  });
  emitRaw({ kind: 'session.reset', sessionId: 'sess_preview_plan', reason: 'new' });
  emit('session.started', { sessionId: 'sess_preview_plan', title: '给 tools.ts 补符号链接护栏' });
  emit('user.message', { text: '帮我给 `tools.ts` 补上符号链接的越界校验。', planMode: true });
  emit('reasoning.delta', {
    delta: '计划模式：本轮只读调研、不改动文件，产出一份方案供你批准……',
  });
  emit('tool.started', { tool: 'read_file', input: { path: 'src/daemon/tools.ts' } });
  emit('tool.executed', { tool: 'read_file', ok: true, output: '(文件内容略)', durationMs: 18 });
  emit('tool.started', { tool: 'grep', input: { pattern: 'realpath', path: 'src/daemon' } });
  emit('tool.executed', { tool: 'grep', ok: true, output: '2 处匹配', durationMs: 7 });

  const doc = globalThis.document;
  const clickBar = (label) => {
    const b = [...doc.querySelectorAll('#pending-actions button')].find((n) => n.textContent === label);
    if (!b) throw new Error('[uiPreview] 待办条上没有按钮：' + label);
    b.click();
  };

  // ① 第一份计划被拒绝 —— 决策即折叠，但绝不删除（审计记录），标题行留「已拒绝」徽标
  emit('plan.request', {
    planId: 'plan_preview_rejected',
    plan: '## 计划\n\n1. **目标**：让越界校验覆盖符号链接。\n2. **步骤**：直接改用 `fs.realpathSync` 比较。\n3. **涉及文件**：`src/daemon/tools.ts`',
    expiresAt: Date.now() + EXPIRES,
  });
  clickBar('不同意');

  // ② 第二份计划挂起中 —— 完整正文 + 补充意见输入框 + 倒计时
  emit('plan.request', {
    planId: 'plan_preview_pending',
    plan: [
      '## 计划',
      '',
      '### 1. 目标',
      '让 `resolveInWorkspace` 在符号链接 / 目录联结指向工作区外时同样拒绝。',
      '',
      '### 2. 步骤',
      '1. 读取 `tools.ts` 的 `resolveInWorkspace`（已完成）',
      '2. 在字符串前缀比较**之前**插入 `fs.realpathSync`',
      '3. 用解析后的规范路径重新比对工作区前缀',
      '4. 保持既有 `..` / NUL / ADS 用例的行为不变',
      '',
      '### 3. 涉及文件',
      '- 修改 `src/daemon/tools.ts`',
      '- 新增用例 `src/daemon/tools.test.ts`',
      '',
      '### 4. 风险与待确认',
      '- Windows junction 是否要单独处理？（建议一并补）',
      '- `file.read` 是否也加同一道校验？（会影响既有测试，需你拍板）',
    ].join('\n'),
    expiresAt: Date.now() + EXPIRES,
  });
  if (!doc.querySelector('.card.plan')) throw new Error('[uiPreview] 没有渲染出计划卡');
});

// ---- 场景九：图片附件（P2-4）----
// 一条"粘贴截图 → 发送 → 再粘一张"的完整路径，一次展示三处新界面：
// 用户气泡里的缩略图、下方待发送的暂存区、以及输入框旁的附加按钮。
// 走的是真实路径（派发 paste 事件 → stageImageFiles → send），不是直接改 DOM。
const imageDom = await renderScenario(async ({ emit, emitRaw, posted }) => {
  emitRaw({
    kind: 'init',
    state: {
      sessionId: 'sess_preview_image',
      connected: true,
      agent: 'real',
      model: 'deepseek-flash',
      history: [],
    },
  });
  emitRaw({ kind: 'session.reset', sessionId: 'sess_preview_image', reason: 'new' });

  const win = globalThis.window;
  const doc = globalThis.document;
  const makeFile = (name) =>
    new win.File([new Uint8Array(SHOT_PNG_BYTES)], name, { type: 'image/png' });

  // 粘贴：剪贴板里的截图在 jsdom 里只能靠一个带 clipboardData 的 paste 事件来模拟
  const paste = (name) => {
    const ev = new win.Event('paste');
    ev.clipboardData = { files: [makeFile(name)], items: [] };
    doc.getElementById('input').dispatchEvent(ev);
  };
  // 暂存要等 FileReader 真的读回来。用轮询而不是固定 sleep：固定 sleep 要么不够
  // （预览里静默少一张图），要么白等（CI 上拖慢）—— 两种都不该出现在一个"看一眼"的脚本里。
  const waitThumbs = async (n, what) => {
    for (let i = 0; i < 150; i++) {
      if (doc.querySelectorAll('#image-staging .image-thumb').length === n) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('[uiPreview] 等待超时：' + what);
  };

  paste('报错截图.png');
  await waitThumbs(1, '第一张图进入暂存区');

  doc.getElementById('input').value = '这个报错怎么修？';
  doc.getElementById('btn-send').click();

  // 扩展确认收到后回显（图片 chip 只带 imageId，不带 base64）
  const sent = posted.find((m) => m.kind === 'send');
  if (!sent || !sent.images || sent.images.length === 0) {
    throw new Error('[uiPreview] 图片没有被暂存/发送');
  }
  emit('user.message', {
    text: '这个报错怎么修？',
    attachments: [
      ...sent.images.map((i) => ({ label: '🖼 ' + i.name, imageId: i.clientId })),
      { label: 'app.ts' },
      { label: '选区 L12-30' },
    ],
  });
  // session.started 在**发送之后**才到（真实时序如此）——而它会把输入区置为 running，
  // 所以场景里绝不能提前发，否则 send() 会被自己的"处理中"挡住。
  emit('session.started', { sessionId: 'sess_preview_image', title: '修一下这个报错' });
  emit('reasoning.delta', { delta: '先看这张截图里的报错栈……' });
  emit('message.delta', { delta: '截图里这两行是同一个错误的两次抛出，直接看第二行即可。' });
  emit('message.done', {});
  emit('session.ended', { reason: 'completed' });

  // 再粘一张：展示"待发送暂存区"（含删除按钮与尺寸提示）
  paste('console-output.png');
  await waitThumbs(1, '第二张图进入暂存区');
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
    <figure>
      <figcaption>⑧ 侧边栏 340px · 计划模式：方案待批准（上为已拒绝的折叠态）（浅色主题）</figcaption>
      <div class="frame narrow"><iframe id="f-narrow-plan"></iframe></div>
    </figure>
    <figure>
      <figcaption>⑨ 侧边栏 340px · 图片附件：气泡缩略图 + 待发送暂存区（浅色主题）</figcaption>
      <div class="frame narrow"><iframe id="f-narrow-image"></iframe></div>
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
<script type="text/plain" id="dom-plan">${esc(planDom)}</script>
<script type="text/plain" id="dom-image">${esc(imageDom)}</script>
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
  const plan = txt('dom-plan');
  const image = txt('dom-image');
  document.getElementById('f-narrow-light').srcdoc = build(conv, 'theme-light');
  document.getElementById('f-wide-light').srcdoc = build(conv, 'theme-light');
  document.getElementById('f-narrow-dark').srcdoc = build(empty, 'theme-dark');
  document.getElementById('f-narrow-decided').srcdoc = build(decided, 'theme-light');
  document.getElementById('f-narrow-newsession').srcdoc = build(newsession, 'theme-light');
  document.getElementById('f-narrow-restricted').srcdoc = build(restricted, 'theme-light');
  document.getElementById('f-narrow-settings').srcdoc = build(settings, 'theme-light');
  document.getElementById('f-narrow-plan').srcdoc = build(plan, 'theme-light');
  document.getElementById('f-narrow-image').srcdoc = build(image, 'theme-light');
</script>
</body>
</html>
`;

writeFileSync(new URL('./ui-preview.html', import.meta.url), preview, 'utf8');
console.log(`[uiPreview] 已生成 scripts/ui-preview.html（${(preview.length / 1024).toFixed(1)} KB）`);
process.exit(0);