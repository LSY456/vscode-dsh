// @vitest-environment jsdom
/**
 * dsh 面板（media/webview.js）结构与交互契约测试。
 *
 * 这些断言锁定的是「UI 设计决策」，而不是实现细节：
 *  - 用户消息只回显一次（此前 webview 本地回显 + 扩展回发导致两条重复气泡）；
 *  - 用户消息带上下文 chip（Agent 实际拿到什么，用户看得见）；
 *  - 工具调用聚合为一条「过程」时间线，而不是逐个堆卡片；
 *  - 挂起项（审批 / 补丁）必须投影到输入框上方的待办条，滚到哪儿都不会漏掉；
 *  - 待办条按钮回传的协议消息与卡片按钮完全一致。
 *
 * 用法：读真实的 media/webview.html 作为骨架，注入真实 bundle 入口 media/webview.js。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

/** webview 通过 acquireVsCodeApi().postMessage 回传给扩展的消息 */
const posted = [];

/** 「复制回答原文」写入剪贴板的载荷（断言复制的是 Markdown 源文而非渲染后的纯文本） */
const clipboardWrites = [];

function emitEvent(method, params) {
  window.dispatchEvent(new MessageEvent('message', { data: { kind: 'event', method, params } }));
}

function emitRaw(data) {
  window.dispatchEvent(new MessageEvent('message', { data }));
}

function lastMessageOfKind(kind) {
  for (let i = posted.length - 1; i >= 0; i -= 1) {
    if (posted[i].kind === kind) return posted[i];
  }
  return undefined;
}

function pendingButton(label) {
  return [...document.querySelectorAll('#pending-actions button')].find((b) => b.textContent === label);
}

beforeAll(async () => {
  const html = readFileSync(path.join(repoRoot, 'media', 'webview.html'), 'utf8');
  const body = html
    .slice(html.indexOf('<body>') + '<body>'.length, html.lastIndexOf('</body>'))
    .replace(/<script[\s\S]*?<\/script>/g, '');
  document.body.innerHTML = body;
  // webview 宿主注入的 API（真实运行时由 VSCode 提供）
  globalThis.acquireVsCodeApi = () => ({ postMessage: (m) => posted.push(m) });
  // 剪贴板桩：jsdom 没有 navigator.clipboard，而「复制」的**载荷内容**必须可断言
  // （流式渲染后 DOM 里已是剥掉标记的 HTML，拿它当复制源会静默破坏原文）
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: (text) => { clipboardWrites.push(text); return Promise.resolve(); } },
  });
  await import('../../media/webview.js');
});

describe('面板骨架', () => {
  it('就绪后立即向扩展上报 ready', () => {
    expect(posted.some((m) => m.kind === 'ready')).toBe(true);
  });

  it('init 后展示当前 Agent 实现与会话（mock 还是 real 一眼可见）', () => {
    emitRaw({
      kind: 'init',
      state: {
        sessionId: 'sess_abcdef123456',
        connected: true,
        agent: 'real',
        model: 'deepseek-chat',
        history: [],
      },
    });
    const agentEl = document.getElementById('agent-mode');
    expect(agentEl.hidden).toBe(false);
    // 徽标只显示当前模型，不再带 `真实模型 · ` 这个多余的定语
    expect(agentEl.textContent).toBe('deepseek-chat');
    // 状态行里不再有面向使用者的会话号徽标；排障用的会话号挪到 data-session / 悬停提示
    expect(document.getElementById('session-id')).toBe(null);
    expect(document.getElementById('meta-bar').dataset.session).toBe('sess_abcdef123456');
    expect(document.getElementById('conn-dot').className).toContain('connected');
  });
});

describe('用户回合', () => {
  it('只回显一次，并展示上下文 chip', () => {
    emitEvent('user.message', {
      text: '看下这段实现',
      attachments: [{ label: 'render.js' }, { label: '选区 L12-30' }],
    });
    expect(document.querySelectorAll('.message.user').length).toBe(1);
    const chips = [...document.querySelectorAll('.chip')].map((n) => n.textContent);
    expect(chips).toEqual(['render.js', '选区 L12-30']);
    expect(document.getElementById('empty').style.display).toBe('none');
  });

  it('Markdown 渲染并净化（不引入脚本）', () => {
    // 注意：Markdown 的 HTML 块会吞掉同一行的后续文本，故用空行分隔
    emitEvent('user.message', { text: '<script>alert(1)</script>\n\n**加粗**' });
    const user = document.querySelectorAll('.message.user');
    expect(user.length).toBe(2);
    expect(user[1].innerHTML).not.toMatch(/<script/i);
    expect(user[1].innerHTML).toContain('<strong>加粗</strong>');
  });
});

describe('过程（工具调用）', () => {
  it('聚合成一条时间线，且不再为每个工具生成卡片', () => {
    emitEvent('tool.started', { tool: 'read_file', input: { path: 'src/webview/render.js' } });
    emitEvent('tool.executed', { tool: 'read_file', ok: true, output: 'const x = 1;', durationMs: 12 });
    const rows = document.querySelectorAll('.activity .tool-row');
    expect(rows.length).toBe(1);
    expect(rows[0].className).toContain('ok');
    expect(rows[0].textContent).toContain('src/webview/render.js');
    expect(document.querySelector('.activity-head').textContent).toContain('1 步');
    // 工具调用不进卡片体系
    expect(document.querySelectorAll('.card').length).toBe(0);
  });

  it('过程默认折叠：结论不被过程细节挤出视野', () => {
    expect(document.querySelector('.activity').className).toContain('collapsed');
    // 折叠时列表整体不渲染（由 CSS 负责），但头部仍持续给出步数反馈
    expect(document.querySelector('.activity-head').textContent).toContain('步');
  });

  it('失败的步骤行内标注 + 头部计数，但不自动展开输出', () => {
    // 回归：原先失败行会自动 open，一轮连错几次就会把结论顶出好几屏
    emitEvent('tool.started', { tool: 'bash_execute', input: { command: 'rm -rf /' } });
    emitEvent('tool.executed', { tool: 'bash_execute', ok: false, output: '命令被拒绝', durationMs: 3 });
    const rows = document.querySelectorAll('.activity .tool-row');
    expect(rows.length).toBe(2);
    expect(rows[1].className).toContain('failed');
    expect(rows[1].className).not.toContain('open');
    expect(rows[1].textContent).toContain('失败');
    expect(rows[1].textContent).toContain('命令被拒绝'); // 输出仍在 DOM 里，点开即可看
    expect(document.querySelector('.activity-head').textContent).toContain('1 失败');
  });
});

describe('审批卡与待办条', () => {
  it('审批请求：卡片入流 + 待办条可见 + 倒计时', () => {
    emitEvent('approval.request', {
      approvalId: 'ap1',
      tool: 'bash_execute',
      input: { command: 'rm -rf /' },
      risk: 'high',
      reason: '高危命令需人工审批',
      expiresAt: Date.now() + 60_000,
    });
    const card = document.querySelector('.card.approval');
    expect(card).not.toBeNull();
    expect(card.className).toContain('risk-high');
    const bar = document.getElementById('pending-bar');
    expect(bar.hidden).toBe(false);
    expect(bar.textContent).toContain('bash_execute');
    expect(bar.textContent).toContain('高危命令需人工审批');
    expect(bar.textContent).toMatch(/⏱/);
  });

  it('待办条「接受」回传协议消息并清空待办（卡片保留为历史）', () => {
    pendingButton('接受').click();
    expect(lastMessageOfKind('approval.respond')).toMatchObject({
      approvalId: 'ap1',
      approved: true,
    });
    expect(document.getElementById('pending-bar').hidden).toBe(true);
    expect(document.querySelector('.card.approval').className).toContain('decided');
    expect(document.querySelector('.card.approval').textContent).toContain('已接受');
  });

  it('决策后卡片自动折叠、操作按钮收起（不再留一排点不动的按钮）', () => {
    const card = document.querySelector('.card.approval');
    // 回归：此前只加 .decided 置灰，正文与三个按钮全留在原地，
    // 用户点完看着一排没反应的按钮，判断为"选项卡无法隐藏"。
    expect(card.className).toContain('collapsed');
    const actions = card.querySelector('.card-actions');
    expect(actions.hidden).toBe(true);
    const buttons = [...actions.querySelectorAll('button')];
    expect(buttons.length).toBe(3);
    expect(buttons.every((b) => b.hidden)).toBe(true);
    // 折叠的是正文，不是结论：结果徽标落在标题行上，折起来也读得到
    expect(card.querySelector('.card-title').textContent).toContain('已接受');
  });

  it('折叠的卡片可以再展开（点标题行 / 回车）', () => {
    const card = document.querySelector('.card.approval');
    const title = card.querySelector('.card-title');
    expect(title.querySelector('.chev').textContent).toBe('▾');
    expect(title.getAttribute('aria-expanded')).toBe('false');

    title.click();
    expect(card.className).not.toContain('collapsed');
    expect(title.getAttribute('aria-expanded')).toBe('true');

    title.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(card.className).toContain('collapsed');
  });

  it('「接受并记住」额外带上 trust 标记（B1 免审批白名单）', () => {
    emitEvent('approval.request', {
      approvalId: 'ap2',
      tool: 'bash_execute',
      input: { command: 'npm test' },
      risk: 'medium',
      reason: '普通命令',
    });
    pendingButton('接受并记住').click();
    expect(lastMessageOfKind('approval.respond')).toMatchObject({
      approvalId: 'ap2',
      approved: true,
      trust: true,
    });
  });

  it('审批过期：卡片置灰、待办条消失', () => {
    emitEvent('approval.request', {
      approvalId: 'ap3',
      tool: 'bash_execute',
      input: { command: 'rm -rf /' },
      risk: 'high',
      reason: '高危命令',
      expiresAt: Date.now() + 60_000,
    });
    expect(document.getElementById('pending-bar').hidden).toBe(false);
    emitEvent('approval.expired', { approvalId: 'ap3' });
    expect(document.getElementById('pending-bar').hidden).toBe(true);
    // 收窄到审批卡内部：工具行失败徽标（本轮新增）也带 .badge.err，
    // 裸 querySelector('.badge.err') 会先命中它而误判。
    expect(document.querySelector('.card.approval .badge.err').textContent).toBe('已过期');
  });
});

describe('补丁卡与待办条', () => {
  it('补丁待审查：待办条给出 Diff / 拒绝 / 应用', () => {
    emitEvent('file.patch.pending', {
      patchId: 'p1',
      path: 'src/webview/render.js',
      oldContent: 'a',
      newContent: 'b',
      description: '调整代码块渲染签名',
    });
    const bar = document.getElementById('pending-bar');
    expect(bar.hidden).toBe(false);
    expect(bar.textContent).toContain('src/webview/render.js');
    expect([...document.querySelectorAll('#pending-actions button')].map((b) => b.textContent)).toEqual([
      '打开 Diff',
      '拒绝',
      '应用',
    ]);
  });

  it('待办条「应用」回传 patch.accept', () => {
    pendingButton('应用').click();
    expect(lastMessageOfKind('patch.accept')).toMatchObject({ patchId: 'p1' });
    expect(document.getElementById('pending-bar').hidden).toBe(true);
  });

  it('补丁落地后卡片标记结果', () => {
    emitEvent('file.patch.result', { patchId: 'p1', accepted: true, applied: true });
    expect(document.querySelector('.card.patch').textContent).toContain('已应用');
  });

  it('补丁卡决策后折叠，但「打开 Diff」豁免保留（仍可回看改了什么）', () => {
    const card = document.querySelector('.card.patch');
    expect(card.className).toContain('collapsed');
    const buttons = [...card.querySelectorAll('.card-actions button')];
    const diff = buttons.find((b) => b.textContent === '打开 Diff');
    expect(diff.hidden).toBe(false);
    expect(buttons.filter((b) => b !== diff).every((b) => b.hidden)).toBe(true);
    // 还有按钮可用，整行就不该收掉
    expect(card.querySelector('.card-actions').hidden).toBe(false);
  });

  it('「打开 Diff」总是直通扩展（不改变待办状态）', () => {
    emitEvent('file.patch.pending', { patchId: 'p2', path: 'src/a.ts', oldContent: '', newContent: 'x' });
    pendingButton('打开 Diff').click();
    expect(lastMessageOfKind('patch.openDiff')).toMatchObject({ patchId: 'p2' });
    expect(document.getElementById('pending-bar').hidden).toBe(false);
  });
});

describe('回答流与键盘', () => {
  it('流式回答落地后渲染 Markdown 并提供复制动作', () => {
    emitEvent('message.delta', { delta: '# 结论\n\n' });
    emitEvent('message.delta', { delta: '已改好 `renderer.code`' });
    const streaming = document.querySelector('.md.streaming');
    expect(streaming).not.toBeNull();
    emitEvent('message.done', {});
    const md = document.querySelector('.turn.assistant .md');
    expect(md.className).not.toContain('streaming');
    expect(md.querySelector('h1').textContent).toBe('结论');
    expect(document.querySelector('.msg-actions')).not.toBeNull();
  });

  it('流式期间就已渲染成排版好的内容，屏幕上不出现原始标记', async () => {
    // 回归：此前流式期间是 `textContent += chunk`（纯文本），而 .message.assistant 没有
    // white-space: pre-wrap —— 换行被折叠，于是表格/代码块/粗体全按源码挤成一行，
    // 满屏 `|`、```、`**` 以及原文里的 ￥ & ： " 等符号，直到 message.done 才变正常。
    emitEvent('message.delta', { delta: '## 结论\n\n' });
    emitEvent('message.delta', { delta: '| 项目 | 价格 |\n|---|---|\n| A | ￥100 & 折扣 |\n' });
    // 等批处理器 flush（无 rAF 时退避为 setTimeout(16)）
    await new Promise((resolve) => setTimeout(resolve, 80));

    const body = document.querySelector('.md.streaming');
    expect(body).not.toBeNull();
    // 已经是真实节点，而不是一串源码文本
    expect(body.querySelector('h2').textContent).toBe('结论');
    expect(body.querySelector('table')).not.toBeNull();
    // 表格单元里的 ￥ / & 是**答案内容**，应作为正文出现在格子里，而不是符号乱码
    expect(body.querySelector('table').textContent).toContain('￥100 & 折扣');
    // 原始标记不再出现在可见文本里
    expect(body.textContent).not.toContain('##');
    expect(body.textContent).not.toContain('|');
    expect(body.textContent).not.toContain('---');
  });

  it('流式渲染只影响过程观感：结束时仍以完整文本做定妆渲染', async () => {
    // 接着上面的半截表格收尾：定妆后段落/表格结构完整
    emitEvent('message.delta', { delta: '\n补充说明。\n' });
    emitEvent('message.done', {});
    const turns = document.querySelectorAll('.turn.assistant');
    const turn = turns[turns.length - 1];
    const md = turn.querySelector('.md');
    expect(md.className).not.toContain('streaming');
    expect(md.querySelector('table')).not.toBeNull();
    expect(md.textContent).toContain('补充说明。');

    // 「复制」必须给出 Markdown 源文（含标记）：流式渲染后 DOM 里只剩剥掉标记的 HTML，
    // 若退回"从 DOM 读 textContent"当复制源，用户拿到的会是丢光结构的纯文本。
    const copyBtn = turn.querySelector('.msg-actions button');
    expect(copyBtn).not.toBeNull();
    copyBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(clipboardWrites).toHaveLength(1);
    expect(clipboardWrites[0]).toContain('## 结论');
    expect(clipboardWrites[0]).toContain('|---|');
  });

  it('推理流默认折叠，结束显示耗时', () => {
    emitEvent('reasoning.delta', { delta: '先看选区，再读文件…' });
    const details = document.querySelector('details.reasoning');
    expect(details.open).toBe(false);
    expect(details.textContent).toContain('思考中');
    emitEvent('message.done', {});
    expect(details.textContent).toContain('已思考');
  });

  it('Esc 优先关闭覆盖面板', () => {
    document.getElementById('btn-settings').click();
    expect(document.getElementById('settings-panel').hidden).toBe(false);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.getElementById('settings-panel').hidden).toBe(true);
  });

  it('设置面板打开时向扩展请求配置与信任规则', () => {
    document.getElementById('btn-settings').click();
    expect(posted.some((m) => m.kind === 'settings.get')).toBe(true);
    expect(posted.some((m) => m.kind === 'trust.list')).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });

  it('历史会话回放：清空当前视图后按 role 渲染', () => {
    emitEvent('history.loaded', {
      sessionId: 'sess_old',
      title: '旧会话',
      messages: [
        { role: 'user', text: '你好' },
        { role: 'assistant', text: '**收到**' },
        { role: 'system', text: '系统提示' },
      ],
    });
    expect(document.querySelectorAll('.message.user').length).toBe(1);
    expect(document.querySelectorAll('.turn.assistant').length).toBe(1);
    expect(document.querySelector('.message.system').textContent).toBe('系统提示');
    expect(document.getElementById('trajectory-box').hidden).toBe(true);
  });
});

describe('会话管理（新会话 / 切换 / 重连重放）', () => {
  it('顶栏「新会话」按钮向扩展请求新建会话', () => {
    document.getElementById('btn-new').click();
    expect(lastMessageOfKind('session.new')).toBeTruthy();
  });

  it('session.reset(new)：清空视图、更新会话号，并把空态欢迎块交还给用户', () => {
    const before = document.querySelectorAll('.message.user').length;
    emitEvent('user.message', { text: '旧会话里的问题' });
    expect(document.querySelectorAll('.message.user').length).toBe(before + 1);
    // 有对话内容时，空态是收起的
    expect(document.getElementById('empty').style.display).toBe('none');

    emitRaw({ kind: 'session.reset', sessionId: 'sess_new_0001', reason: 'new' });

    expect(document.querySelectorAll('.message.user').length).toBe(0);
    expect(document.getElementById('meta-bar').dataset.session).toBe('sess_new_0001');
    // 消息区空了 → 欢迎块回来（用户报的"新建会话后一片空白"就在这里）
    expect(document.getElementById('empty').style.display).not.toBe('none');
    // 且不再往消息流里插「已新建会话：sess_xxx」——那句系统行会把欢迎块当场顶掉，
    // 而会话号对使用者没有意义（排障那份在 meta-bar.dataset.session）
    expect(document.querySelectorAll('#messages .message').length).toBe(0);
  });

  it('session.reset(switch)：提示已切换且可继续对话', () => {
    emitRaw({ kind: 'session.reset', sessionId: 'sess_old_0002', reason: 'switch' });
    const texts = [...document.querySelectorAll('.message.system')].map((n) => n.textContent);
    expect(texts.some((t) => t.includes('已切换到该会话'))).toBe(true);
    // 会话号同样不出现在给用户看的文案里
    expect(texts.some((t) => t.includes('sess_old_0002'))).toBe(false);
  });

  it('session.reset(replay)：断线重连提示重放中', () => {
    emitRaw({ kind: 'session.reset', sessionId: 'sess_same', reason: 'replay' });
    const texts = [...document.querySelectorAll('.message.system')].map((n) => n.textContent);
    expect(texts.some((t) => t.includes('正在重放'))).toBe(true);
  });

  it('notice 事件渲染为系统消息（历史只读回放场景）', () => {
    emitEvent('notice', { text: '该会话已结束（daemon 重启过）' });
    const texts = [...document.querySelectorAll('.message.system')].map((n) => n.textContent);
    expect(texts.some((t) => t.includes('该会话已结束'))).toBe(true);
  });
});

/**
 * 空态欢迎块：用户报的「点了新建会话，新页面一片空白」就发生在这里。
 *
 * 失效路径很隐蔽 —— clearMessages() 已经把空态露出来了，但紧随其后的
 * 「已新建会话：sess_xxx」系统行走的是 addMessage()，又把空态藏了回去：
 * 于是新页面只剩一行会话号，标题 / 提示 / 可点的起点全都不见。
 * 现在可见性只由「消息区是否为空」单点决定，下面几条把这条不变式钉住。
 */
describe('空态欢迎块（新建会话后必须回来）', () => {
  const emptyVisible = () => document.getElementById('empty').style.display !== 'none';
  const suggestItems = () => [...document.querySelectorAll('#suggest .suggest-item')];

  it('新建会话后欢迎块与可点建议项一起回来', () => {
    emitRaw({ kind: 'session.reset', sessionId: 'sess_empty_a', reason: 'new' });
    expect(emptyVisible()).toBe(true);
    expect(document.querySelector('.empty-title').textContent).toContain('dsh Agent');

    const items = suggestItems();
    expect(items.length).toBeGreaterThanOrEqual(3);
    for (const item of items) {
      expect(item.dataset.prompt.trim().length).toBeGreaterThan(0);
      expect(item.querySelector('.suggest-body').textContent.trim().length).toBeGreaterThan(0);
      // 图标是 JS 注入的那段 SVG，漏了就会渲染成一个空白行首
      expect(item.querySelector('.suggest-icon svg')).toBeTruthy();
    }
  });

  it('点击建议项只填入输入框，不直接发送', () => {
    const sends = posted.filter((m) => m.kind === 'send').length;
    const input = document.getElementById('input');
    input.value = '';
    const first = suggestItems()[0];
    first.click();
    expect(input.value).toBe(first.dataset.prompt);
    expect(posted.filter((m) => m.kind === 'send').length).toBe(sends);
  });

  it('不同会话号给出不同的建议组合（不是每次新建都一模一样）', () => {
    const combos = new Set();
    for (const id of ['sess_r1', 'sess_r2', 'sess_r3', 'sess_r4', 'sess_r5', 'sess_r6']) {
      emitRaw({ kind: 'session.reset', sessionId: id, reason: 'new' });
      combos.add(suggestItems().map((n) => n.dataset.prompt).join('|'));
    }
    expect(combos.size).toBeGreaterThan(1);
  });

  it('新一轮对话开始后，空态再次收起', () => {
    emitRaw({ kind: 'session.reset', sessionId: 'sess_empty_b', reason: 'new' });
    expect(emptyVisible()).toBe(true);
    emitEvent('user.message', { text: '这一轮问点别的' });
    expect(emptyVisible()).toBe(false);
  });

  it('建议项重建后点击依然有效（委派监听，不是逐项挂监听）', () => {
    // 逐项 addEventListener 会在每次空态重建后全部失效 —— 点上去毫无反应
    emitRaw({ kind: 'session.reset', sessionId: 'sess_empty_c', reason: 'new' });
    const input = document.getElementById('input');
    input.value = '';
    const last = suggestItems().pop();
    last.click();
    expect(input.value).toBe(last.dataset.prompt);
  });
});

describe('surface 重建后的挂起项恢复', () => {
  it('init.pending 恢复审批卡 / 补丁卡与待办条（含倒计时）', () => {
    emitRaw({
      kind: 'init',
      state: {
        sessionId: 'sess_x',
        connected: true,
        history: [],
        pending: {
          approvals: [
            {
              approvalId: 'ap_restore',
              sessionId: 'sess_x',
              tool: 'bash_execute',
              input: { command: 'rm -rf /' },
              risk: 'high',
              reason: '高危命令',
              expiresAt: Date.now() + 30_000,
            },
          ],
          patches: [
            {
              patchId: 'pt_restore',
              sessionId: 'sess_x',
              path: 'src/a.ts',
              newContent: 'x',
              expiresAt: Date.now() + 30_000,
            },
          ],
        },
      },
    });
    expect(document.querySelector('.card.approval')).not.toBeNull();
    expect(document.querySelector('.card.patch')).not.toBeNull();
    const bar = document.getElementById('pending-bar');
    expect(bar.hidden).toBe(false);
    expect(bar.textContent).toMatch(/⏱ \d+s/);
    expect(bar.textContent).toContain('bash_execute');
  });

  it('补丁卡显示过期倒计时（daemon 盖戳 expiresAt）', () => {
    const card = document.querySelector('.card.patch');
    expect(card.textContent).toMatch(/剩余 \d+s/);
  });

  it('恢复出来的挂起项保持展开，用户仍能直接操作', () => {
    // 折叠只属于"已决策"的卡片；挂起项还没决策，折起来等于让用户多点一次
    const card = document.querySelector('.card.approval');
    expect(card.className).not.toContain('collapsed');
    const buttons = [...card.querySelectorAll('.card-actions button')];
    expect(buttons.length).toBe(3);
    expect(buttons.every((b) => !b.hidden)).toBe(true);
  });
});

/**
 * 状态横幅：一块 UI 承载两种"当前为什么不好用"。
 *
 * ① 演示模式：未配置模型 Key 时**必须显式告知**，不能静默降级（旧行为直接走 mock 关键字循环，
 *    用户会把模拟回复当成真实模型的回答）；
 * ② 受限模式：工作区未被信任时 daemon 不启动（P0-1 安全门禁），必须说清"为什么不能用"并给出信任入口。
 * 二者互斥且**受限模式优先**：未受信任时 daemon 根本没启动，再讲"没配 Key 所以是模拟回复"就是误导。
 */
describe('状态横幅：演示模式', () => {
  it('mock + 缺 Key：横幅可见、模式 chip 警示、文案点明成因', () => {
    emitEvent('agent.info', { agent: 'mock', agentReason: 'no-api-key', model: 'deepseek-chat' });
    const banner = document.getElementById('state-banner');
    expect(banner.hidden).toBe(false);
    expect(document.getElementById('state-banner-tag').textContent).toBe('演示模式');
    expect(document.getElementById('state-banner-text').textContent).toContain('未配置模型 Key');
    const chip = document.getElementById('agent-mode');
    expect(chip.className).toContain('warn');
    expect(chip.textContent).toContain('演示模式');
  });

  it('横幅「配置模型」直达设置面板', () => {
    document.getElementById('btn-state-action').click();
    expect(document.getElementById('settings-panel').hidden).toBe(false);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });

  it('演示模式下：mock 专属入口可见，点击填入关键字咒语', () => {
    const demoItem = document.querySelector('#suggest [data-demo-only]');
    expect(demoItem).toBeTruthy();
    expect(demoItem.hidden).toBe(false);
    document.getElementById('input').value = '';
    demoItem.click();
    expect(document.getElementById('input').value).toContain('danger');
  });

  it('接入真实模型后：横幅撤下、mock 专属入口隐藏、建议项回到自然语言', () => {
    emitEvent('agent.info', { agent: 'real', model: 'deepseek-chat' });
    expect(document.getElementById('state-banner').hidden).toBe(true);
    expect(document.getElementById('agent-mode').className).not.toContain('warn');
    expect(document.querySelector('#suggest [data-demo-only]').hidden).toBe(true);
    const plain = document.querySelector('#suggest .suggest-item:not([data-demo-only])');
    document.getElementById('input').value = '';
    plain.click();
    expect(document.getElementById('input').value).toBe(plain.dataset.prompt);
    // 通用建议项一律自然语言：内部演示语法（danger / write edit）不该出现在真实模型的路径上
    expect(plain.dataset.prompt).not.toMatch(/danger|write edit/);
  });

  it('显式 mock（forced-mock）用另一套文案，不误报成"忘了配 Key"', () => {
    emitEvent('agent.info', { agent: 'mock', agentReason: 'forced-mock' });
    const text = document.getElementById('state-banner-text').textContent;
    expect(text).toContain('agent=mock');
    expect(text).not.toContain('未配置模型 Key');
  });

  it('agent 未知时不显示横幅（避免无依据的误报）', () => {
    emitEvent('agent.info', {});
    expect(document.getElementById('state-banner').hidden).toBe(true);
    expect(document.getElementById('agent-mode').hidden).toBe(true);
  });
});

/**
 * 受限模式（P0-1）的用户面：工作区未被信任时**连 daemon 都不启动**。
 *
 * 这里锁的不是"有个横幅"，而是**安全默认值必须可自救**：
 * 说清为什么 + 给出点哪里，且动作不能走错（点"信任此工作区"却打开设置面板就是死路）。
 */
describe('状态横幅：受限模式（工作区未被信任）', () => {
  const trusted = { blocked: false, statusLabel: '', statusDetail: '', banner: null };
  const restricted = {
    blocked: true,
    statusLabel: '受限模式',
    statusDetail: '当前工作区未被信任（受限模式），Agent 未启动：它需要读写工作区文件、执行命令。',
    banner: {
      tag: '受限模式',
      text: '当前工作区未被信任，Agent 未启动 —— 它需要读写工作区文件、执行命令。',
      actionLabel: '信任此工作区',
    },
  };

  it('init 快照带 trust：横幅显示受限模式与信任入口', () => {
    emitRaw({
      kind: 'init',
      state: { sessionId: 'sess_trust', connected: false, history: [], trust: restricted },
    });
    expect(document.getElementById('state-banner').hidden).toBe(false);
    expect(document.getElementById('state-banner-tag').textContent).toBe('受限模式');
    expect(document.getElementById('state-banner-text').textContent).toContain('未启动');
    expect(document.getElementById('btn-state-action').textContent).toBe('信任此工作区');
  });

  it('受限模式的按钮请求扩展走信任流程，而不是打开设置面板', () => {
    const settingsWasHidden = document.getElementById('settings-panel').hidden;
    const before = posted.filter((m) => m.kind === 'trust.manage').length;
    document.getElementById('btn-state-action').click();
    expect(posted.filter((m) => m.kind === 'trust.manage').length).toBe(before + 1);
    expect(document.getElementById('settings-panel').hidden).toBe(settingsWasHidden);
  });

  it('受限模式优先于演示模式（daemon 没启动时谈"没配 Key"是误导）', () => {
    emitEvent('agent.info', { agent: 'mock', agentReason: 'no-api-key', model: 'deepseek-chat' });
    expect(document.getElementById('state-banner-tag').textContent).toBe('受限模式');
    expect(document.getElementById('state-banner-text').textContent).not.toContain('未配置模型 Key');
  });

  it('用户信任后（trust.info）：受限横幅撤下，按真实情况交还给演示模式横幅', () => {
    emitEvent('trust.info', trusted);
    // 此刻 daemon 仍是 mock（未配 Key），于是演示模式横幅接着显示 —— 而不是整块消失
    expect(document.getElementById('state-banner-tag').textContent).toBe('演示模式');
    expect(document.getElementById('state-banner-text').textContent).toContain('未配置模型 Key');

    // 真的没有"不好用"的理由时，整块收起（不留空白占位）
    emitEvent('agent.info', { agent: 'real', model: 'deepseek-chat' });
    expect(document.getElementById('state-banner').hidden).toBe(true);
  });

  it('受限期在状态行显示中文标签，而不是内部枚举', () => {
    emitRaw({ kind: 'status', status: 'restricted', detail: '工作区未被信任（受限模式）' });
    const status = document.getElementById('status');
    expect(status.textContent).toContain('受限模式');
    expect(status.textContent).not.toContain('restricted');
    expect(status.title).toContain('受限模式');
  });
});

/**
 * 布局重编排：锁定新的信息层级，防止后续改动把界面退回
 * 「顶部两条 bar + 底部三个区块堆叠 + 靠气泡方向区分说话人」的旧形态。
 *
 * 三件事：
 *  1. 消息用「角色列 + 全宽正文」，说话人由角色标记指明；
 *  2. 执行迹线是审计信息，只亮计数、不主动弹面板打断阅读；
 *  3. 顶栏显示当前会话标题（有才显示，没有不留占位）。
 */
describe('布局重编排（角色列 / 迹线按需 / 会话标题）', () => {
  it('用户与助手消息都带角色标记', () => {
    emitRaw({ kind: 'session.reset', sessionId: 'sess_layout', reason: 'new' });
    emitEvent('user.message', { text: '布局检查' });
    const userTurn = document.querySelector('#messages .turn.user');
    expect(userTurn.querySelector(':scope > .role').textContent).toBe('你');

    emitEvent('message.delta', { delta: '收到' });
    emitEvent('message.done', {});
    const agentTurn = document.querySelector('#messages .turn.assistant');
    expect(agentTurn.querySelector(':scope > .role').textContent).toBe('dsh');
  });

  it('迹线只亮计数，不主动弹面板；点按钮才打开', () => {
    const box = document.getElementById('trajectory-box');
    const btn = document.getElementById('btn-trajectory');
    expect(btn.hidden).toBe(true);

    emitEvent('trajectory.record', { step: 1, kind: 'tool', detail: 'read_file' });
    expect(box.hidden).toBe(true); // 审计信息不打断对话
    expect(btn.hidden).toBe(false);
    expect(document.getElementById('traj-badge').textContent).toBe('1');
    expect(document.getElementById('traj-count').textContent).toBe('1 步');
    expect(document.getElementById('trajectory').textContent).toContain('read_file');

    btn.click();
    expect(box.hidden).toBe(false);
    document.getElementById('btn-trajectory-close').click();
    expect(box.hidden).toBe(true);
  });

  it('三个覆盖面板互斥：打开设置会收起迹线', () => {
    document.getElementById('btn-trajectory').click();
    expect(document.getElementById('trajectory-box').hidden).toBe(false);
    document.getElementById('btn-settings').click();
    expect(document.getElementById('settings-panel').hidden).toBe(false);
    expect(document.getElementById('trajectory-box').hidden).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.getElementById('settings-panel').hidden).toBe(true);
  });

  it('会话标题显示在顶栏，无标题时收起', () => {
    const titleEl = document.getElementById('session-title');
    expect(titleEl.hidden).toBe(true);
    emitEvent('session.started', { sessionId: 'sess_title_1', title: '重构面板布局' });
    expect(titleEl.hidden).toBe(false);
    expect(titleEl.textContent).toBe('重构面板布局');
  });
});

/**
 * 折叠的 DOM ↔ CSS 契约。
 *
 * 为什么要单独测：上面的断言只能证明 JS 在卡片上加了 `.collapsed`、并且把正文包进了
 * `.card-body`。但真正决定"看不看得见"的是样式表里的选择器——`.card-body` 拼错、`>`
 * 写成空格、或者规则被谁删掉，DOM 断言照样全绿，而界面上卡片依旧是摊开的（这正是本次
 * 用户报的"选项卡无法隐藏"）。
 *
 * 所以这里把两半接起来：CSS 文本必须含有那条规则，且 JS 生成的 DOM 必须真的 matches() 它。
 */
describe('折叠的 DOM ↔ CSS 契约', () => {
  const css = readFileSync(path.join(repoRoot, 'media', 'webview.css'), 'utf8');

  it('样式表声明了折叠规则与正文块的 flex 节奏', () => {
    expect(css).toMatch(/\.card\.collapsed\s*>\s*\.card-body\s*\{[^}]*display:\s*none/);
    // 正文块必须自己重建间距：迁移后不再由 .card 的 gap 兜底
    expect(css).toMatch(/\.card-body\s*\{[^}]*display:\s*flex/);
    // 变量 hidden 的硬性兜底还在（.card-actions 自带 display:flex，会盖掉 UA 的 [hidden]）
    expect(css).toMatch(/\[hidden\]\s*\{[^}]*display:\s*none\s*!important/);
  });

  it('已决策卡片的正文命中折叠选择器，标题行不命中', () => {
    emitRaw({ kind: 'session.reset', sessionId: 'sess_css_contract', reason: 'new' });
    emitEvent('approval.request', {
      approvalId: 'ap_css_contract',
      tool: 'bash_execute',
      input: { command: 'npm test' },
      risk: 'medium',
      reason: '普通命令',
    });
    const card = document.querySelector('.card.approval');
    const body = card.querySelector('.card-body');
    const title = card.querySelector('.card-title');
    // 决策前：正文不命中折叠选择器（即保持展开）
    expect(body.matches('.card.collapsed > .card-body')).toBe(false);

    pendingButton('接受').click();

    expect(card.className).toContain('collapsed');
    expect(body.matches('.card.collapsed > .card-body')).toBe(true);
    // 标题行是折叠后唯一保留的一行，不能被同一条规则吃掉
    expect(title.matches('.card.collapsed > .card-body')).toBe(false);
  });
});

describe('面板：会话结束原因必须说人话', () => {
  it('session.ended 的英文枚举映射为中文（不再把 completed/error 丢给用户）', () => {
    // "会话为什么结束"正是用户最需要看懂的信息：此前直接展示协议枚举 completed/error，
    // 用户既不知道发生了什么，也不知道停在哪一步。
    const lastSystem = () => [...document.querySelectorAll('.message.system')].at(-1)?.textContent ?? '';

    emitEvent('session.ended', { reason: 'error' });
    expect(lastSystem()).toContain('出错中止');

    emitEvent('session.ended', { reason: 'canceled' });
    expect(lastSystem()).toContain('已取消');

    emitEvent('session.ended', { reason: 'completed' });
    expect(lastSystem()).toContain('已完成');

    // 未知 reason 原样透出：排障时宁可难看，也不能把信息吞掉
    emitEvent('session.ended', { reason: 'weird_reason' });
    expect(lastSystem()).toContain('weird_reason');
  });
});
