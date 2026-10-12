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

describe('模型设置：模型名是下拉，不是自由输入', () => {
  const modelSelect = () => document.getElementById('inp-model');
  const optionValues = (sel) => [...sel.querySelectorAll('option')].map((o) => o.value);
  const hintText = () => document.getElementById('model-catalog-hint').textContent;

  /** 打开设置面板并投递一次 settings.loaded（面板的真实入口：点按钮 → 扩展回 settings.loaded） */
  const loadSettings = (params) => {
    document.getElementById('btn-settings').click();
    emitEvent('settings.loaded', params);
  };

  const baseConfig = (model) => ({
    config: { model, baseURL: 'https://api.deepseek.com/v1', provider: 'auto', preset: 'default' },
    hasApiKey: true,
  });

  it('模型名渲染成 <select>，选项与选中值都来自扩展下发的列表', () => {
    loadSettings({
      ...baseConfig('deepseek-v4-pro'),
      models: [
        { id: 'deepseek-flash', label: 'deepseek-flash（快速 · 1M）', source: 'live' },
        { id: 'deepseek-v4-pro', label: 'deepseek-v4-pro（强推理）', source: 'live' },
      ],
      modelsHint: '已从 api.deepseek.com 在线更新模型列表（2 个可选）',
    });

    const sel = modelSelect();
    // 契约：这里必须是下拉 —— 手写模型名正是本需求要消灭的出错来源
    expect(sel.tagName).toBe('SELECT');
    expect(optionValues(sel)).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
    expect(sel.value).toBe('deepseek-v4-pro');
    expect(hintText()).toContain('在线更新');
  });

  it('扩展把「当前配置」也下发成选项时，下拉选中它而不是列表第一项', () => {
    // 模型名不在已知列表里（例如老配置里的 deepseek-chat）时，由**扩展**把它作为
    // 「当前配置」项追加进 models（见 src/modelCatalog.ts 的 buildModelCatalog）。
    // 这里验证 webview 会真的选中它，而不是默认跳到列表第一项。
    loadSettings({
      ...baseConfig('deepseek-chat'),
      models: [
        { id: 'deepseek-flash', label: 'deepseek-flash（快速 · 1M）', source: 'builtin' },
        { id: 'deepseek-chat', label: 'deepseek-chat（当前配置，不在已知列表中）', source: 'current' },
      ],
      modelsHint: '内置快照（2026-09-28）；已保留当前配置的 deepseek-chat',
    });

    const sel = modelSelect();
    expect(optionValues(sel)).toEqual(['deepseek-flash', 'deepseek-chat']);
    expect(sel.value).toBe('deepseek-chat');
    expect(hintText()).toContain('已保留当前配置');
  });

  it('后台刷新回来的在线列表：只换选项，不把用户刚选的模型弹回去', () => {
    loadSettings({
      ...baseConfig('deepseek-flash'),
      models: [
        { id: 'deepseek-flash', label: 'deepseek-flash（快速 · 1M）', source: 'builtin' },
        { id: 'deepseek-v4-pro', label: 'deepseek-v4-pro（强推理）', source: 'builtin' },
      ],
      modelsHint: '内置快照（2026-09-28）',
    });

    const sel = modelSelect();
    sel.value = 'deepseek-v4-pro'; // 用户此刻的选择
    emitEvent('settings.models', {
      models: [
        { id: 'deepseek-flash', label: 'deepseek-flash（快速 · 1M）', source: 'live' },
        { id: 'deepseek-v4-pro', label: 'deepseek-v4-pro（强推理）', source: 'live' },
        { id: 'deepseek-v5-preview', label: 'deepseek-v5-preview', source: 'live' },
      ],
      modelsHint: '已从 api.deepseek.com 在线更新模型列表（3 个可选）',
    });

    expect(optionValues(sel)).toEqual(['deepseek-flash', 'deepseek-v4-pro', 'deepseek-v5-preview']);
    expect(sel.value).toBe('deepseek-v4-pro');
    expect(hintText()).toContain('3 个可选');
  });

  it('刷新回来是空列表时保持原样（清空字段 + 误点保存 = 配置被改坏）', () => {
    loadSettings({
      ...baseConfig('deepseek-flash'),
      models: [{ id: 'deepseek-flash', label: 'deepseek-flash（快速 · 1M）', source: 'builtin' }],
      modelsHint: '内置快照（2026-09-28）',
    });

    const sel = modelSelect();
    const before = optionValues(sel);
    emitEvent('settings.models', { models: [], modelsHint: '未能获取在线模型列表：请求超时' });

    expect(optionValues(sel)).toEqual(before);
    expect(sel.value).toBe('deepseek-flash');
  });

  it('提交回传选中的模型名；下拉为空时不回传 model（不覆盖已存配置）', () => {
    const submit = () => {
      document
        .getElementById('settings-form')
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      return lastMessageOfKind('settings.apply').settings;
    };

    loadSettings({
      ...baseConfig('deepseek-flash'),
      models: [
        { id: 'deepseek-flash', label: 'deepseek-flash（快速 · 1M）', source: 'live' },
        { id: 'deepseek-v4-pro', label: 'deepseek-v4-pro（强推理）', source: 'live' },
      ],
      modelsHint: '已从 api.deepseek.com 在线更新模型列表（2 个可选）',
    });
    document.getElementById('inp-apikey').value = '';

    const sel = modelSelect();
    sel.value = 'deepseek-v4-pro';
    const sent = submit();
    expect(sent.model).toBe('deepseek-v4-pro');
    // apiKey 留空 = 不修改，不能上报空串把已存凭据删掉
    expect(sent.apiKey).toBeUndefined();

    // 异常情形（列表渲染失败导致下拉为空）：宁可不提交 model，也不要把配置清空
    sel.textContent = '';
    expect(submit().model).toBeUndefined();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
});

/**
 * 状态行上的账户余额 chip。
 *
 * 关键取舍：**未知就整块隐藏**，不显示 0 或 `--` —— 0 余额是很重的结论，
 * 不能靠兜底值给出（拿不到必然有原因：未配 Key / 非官方端点 / 上游没这个接口）。
 */
describe('状态行：账户余额 chip', () => {
  const css = readFileSync(path.join(repoRoot, 'media', 'webview.css'), 'utf8');
  const chip = () => document.getElementById('balance-chip');

  it('扩展没推过余额时保持隐藏，拿到后才出现、且与模型名同一行', () => {
    expect(chip().hidden).toBe(true);

    emitEvent('balance.info', {
      available: true,
      text: '余额 ¥110.00',
      title: 'API 余额 ¥110.00｜赠金 10.00 · 充值 100.00｜更新于 22:50:01｜点击刷新',
      insufficient: false,
    });

    expect(chip().hidden).toBe(false);
    expect(chip().textContent).toBe('余额 ¥110.00');
    expect(chip().className).toBe('meta-chip'); // 余额充足：不加警示色
    expect(chip().title).toContain('赠金 10.00');
    expect(chip().parentElement.id).toBe('meta-bar');
  });

  it('余额不足复用既有的警示 chip 样式，而不是另造一套', () => {
    emitEvent('balance.info', {
      available: true,
      text: '余额 ¥0.00',
      title: 'API 余额 ¥0.00｜余额不足，API 调用可能失败｜点击刷新',
      insufficient: true,
    });
    expect(chip().className).toContain('meta-chip');
    expect(chip().className).toContain('warn');
    expect(chip().title).toContain('余额不足');
  });

  it('不可用时整块隐藏并清空（未配 Key / 非官方端点 / 换了账号）', () => {
    emitEvent('balance.info', { available: false });
    expect(chip().hidden).toBe(true);
    expect(chip().textContent).toBe('');
    expect(chip().title).toBe('');
  });

  it('点击 chip 请求扩展重取余额', () => {
    const before = posted.filter((m) => m.kind === 'balance.refresh').length;
    chip().click();
    expect(posted.filter((m) => m.kind === 'balance.refresh').length).toBe(before + 1);
  });

  it('DOM ↔ CSS 契约：可点手势与警示色规则都在样式表里', () => {
    expect(css).toMatch(/#balance-chip\s*\{[^}]*cursor:\s*pointer/);
    expect(css).toMatch(/\.meta-chip\.warn\s*\{[^}]*border-color/);
    expect(chip().matches('#meta-bar > .meta-chip')).toBe(true);
  });
});

/**
 * 新回合开始前必须强制收尾上一轮。
 *
 * 真实缺陷：上一轮若既没收到 `message.done`、也没收到 `session.ended`（daemon 在流式中崩溃、
 * 事件丢失、连接中断），`answerEl` 会一直挂着；下一轮的 `ensureAnswer()` 直接 early-return，
 * **新一轮的回答被续写进上一轮的气泡里** —— 用户看到的是"答案接在旧答案后面"。
 */
describe('回答流：新回合开始前强制收尾上一轮', () => {
  it('上一轮缺失 message.done 时，新回答自成一条，不混进旧气泡', async () => {
    emitRaw({ kind: 'session.reset', sessionId: 'sess_turn_guard', reason: 'new' });
    expect(document.querySelectorAll('#messages .message').length).toBe(0);

    emitEvent('message.delta', { delta: '第一轮的半截回答' });
    expect(document.querySelectorAll('.turn.assistant .md.streaming').length).toBe(1);

    // 没有 message.done，也没有 session.ended —— 直接开始新回合
    emitEvent('user.message', { text: '第二轮的问题' });

    // ① 上一轮被强制收尾：不再挂着流式正文
    expect(document.querySelectorAll('.turn.assistant .md.streaming').length).toBe(0);
    expect(document.querySelectorAll('.turn.assistant').length).toBe(1);

    emitEvent('message.delta', { delta: '第二轮的答案' });
    // 流式渲染是按体量节流的（≤8KB 每 80ms），等一次 flush 再看 DOM
    await new Promise((resolve) => setTimeout(resolve, 80));

    const turns = document.querySelectorAll('.turn.assistant');
    expect(turns.length).toBe(2); // 新答案另起一条，而不是续写
    expect(turns[0].querySelector('.md').textContent).toContain('第一轮的半截回答');
    expect(turns[1].querySelector('.md').textContent).toContain('第二轮的答案');
    expect(turns[1].querySelector('.md').textContent).not.toContain('第一轮的半截回答');

    emitEvent('message.done', {});
  });
});

/**
 * 静默失败防线。
 *
 * 两类问题此前都是**彻底静默**的：某条事件渲染时抛错、收到前端不认识的事件（协议多了新东西）。
 * 界面上只表现为"没反应"，没有任何线索能区分"协议漂移"与"UI 坏了"。现在都上报诊断，
 * 且只上报、不弹窗、不改产品行为。
 */
describe('静默失败防线：渲染抛错 / 未知事件都要留下线索', () => {
  const diagsFor = (method) =>
    posted.filter((m) => m.kind === 'ui.diag' && m.diag && m.diag.method === method);

  it('前端未实现的协议事件上报 debug 诊断，而不是无声丢弃', () => {
    emitEvent('brand.new.protocol.event', { whatever: 1 });
    const hit = diagsFor('brand.new.protocol.event');
    expect(hit).toHaveLength(1);
    expect(hit[0].diag.level).toBe('debug');
  });

  it('某条事件渲染抛错时上报 warn（附错误信息）', () => {
    // tool.started 缺 params：渲染必抛错，正好用来验证兜底
    emitEvent('tool.started', null);
    const hit = diagsFor('tool.started');
    expect(hit).toHaveLength(1);
    expect(hit[0].diag.level).toBe('warn');
    expect(hit[0].diag.message).toBeTruthy();
  });

  it('上报只走消息通道，不往消息流里插系统行（排障信息不打扰用户）', () => {
    const before = document.querySelectorAll('#messages .message').length;
    emitEvent('another.unknown.event', {});
    expect(document.querySelectorAll('#messages .message').length).toBe(before);
  });
});

/**
 * Agent 预算（工具轮次上限 / 上下文预算）。
 *
 * 这两个值此前只有 daemon 侧读得到、扩展从不下发 —— 用户在设置里根本改不到（"死配置"）。
 * 关键取舍：**留空 = 不修改**，绝不用 `Number('') = 0` 提交空字段，那会把"没填"变成
 * "把上限设成 0"；加载时缺失也要留空而不是显示 0。
 */
describe('设置面板：Agent 预算不再"改不到"', () => {
  const loadSettings = (config) => {
    document.getElementById('btn-settings').click();
    emitEvent('settings.loaded', {
      config: {
        model: 'deepseek-flash',
        baseURL: 'https://api.deepseek.com/v1',
        provider: 'auto',
        ...config,
      },
      hasApiKey: true,
      models: [{ id: 'deepseek-flash', label: 'deepseek-flash（快速 · 1M）', source: 'live' }],
      modelsHint: '已从 api.deepseek.com 在线更新模型列表（1 个可选）',
    });
  };

  const submit = () => {
    document
      .getElementById('settings-form')
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    return lastMessageOfKind('settings.apply').settings;
  };

  it('两个字段都在表单里，且是带区间的数字输入', () => {
    const rounds = document.getElementById('inp-max-rounds');
    const ctx = document.getElementById('inp-max-context');
    expect(rounds).not.toBeNull();
    expect(ctx).not.toBeNull();
    expect(rounds.type).toBe('number');
    expect(rounds.min).toBe('1');
    expect(rounds.max).toBe('50');
    expect(ctx.type).toBe('number');
    expect(ctx.min).toBe('4000');
    expect(ctx.max).toBe('1000000');
  });

  it('settings.loaded 把当前值填进输入框', () => {
    loadSettings({ maxToolRounds: 12, maxContextTokens: 128000 });
    expect(document.getElementById('inp-max-rounds').value).toBe('12');
    expect(document.getElementById('inp-max-context').value).toBe('128000');
  });

  it('缺失时输入框留空，不显示 0（0 会被误读成"上限就是 0"）', () => {
    loadSettings({});
    expect(document.getElementById('inp-max-rounds').value).toBe('');
    expect(document.getElementById('inp-max-context').value).toBe('');
  });

  it('填写后随 settings.apply 提交为数字', () => {
    loadSettings({});
    document.getElementById('inp-max-rounds').value = '16';
    document.getElementById('inp-max-context').value = '65536';
    const sent = submit();
    expect(sent.maxToolRounds).toBe(16);
    expect(sent.maxContextTokens).toBe(65536);
  });

  it('留空 = 不提交该字段（绝不用 Number(\'\') = 0 把上限设成 0）', () => {
    loadSettings({});
    document.getElementById('inp-max-rounds').value = '';
    document.getElementById('inp-max-context').value = '';
    const sent = submit();
    expect(sent.maxToolRounds).toBeUndefined();
    expect(sent.maxContextTokens).toBeUndefined();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
});

/**
 * 采样参数（温度 / 输出上限）。
 *
 * 与上一组的关键差别：这里 `null` 是**有语义**的 —— 它表示"用户从没配过"，面板必须留空、
 * 提交时也不下发，好让 daemon 侧继续用模型层缺省（温度 0.2、上限不发送）。若在扩展侧
 * 回落成一个具体数字，就是把"没配"悄悄变成"配成 0.2"，凭空改变请求体。
 */
describe('设置面板：采样参数可配（批次 2）', () => {
  const loadSettings = (config) => {
    document.getElementById('btn-settings').click();
    emitEvent('settings.loaded', {
      config: {
        model: 'deepseek-flash',
        baseURL: 'https://api.deepseek.com/v1',
        provider: 'auto',
        ...config,
      },
      hasApiKey: true,
      models: [{ id: 'deepseek-flash', label: 'deepseek-flash（快速 · 1M）', source: 'live' }],
      modelsHint: '',
    });
  };

  const submit = () => {
    document
      .getElementById('settings-form')
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    return lastMessageOfKind('settings.apply').settings;
  };

  it('两个字段都在表单里，且是带区间的数字输入', () => {
    const temp = document.getElementById('inp-temperature');
    const max = document.getElementById('inp-max-tokens');
    expect(temp).not.toBeNull();
    expect(max).not.toBeNull();
    expect(temp.type).toBe('number');
    expect(temp.min).toBe('0');
    expect(temp.max).toBe('2');
    expect(max.type).toBe('number');
    expect(max.min).toBe('1');
    expect(max.max).toBe('131072');
  });

  it('settings.loaded 把当前值填进输入框', () => {
    loadSettings({ temperature: 0.7, maxTokens: 8192 });
    expect(document.getElementById('inp-temperature').value).toBe('0.7');
    expect(document.getElementById('inp-max-tokens').value).toBe('8192');
  });

  it('null（用户没配过）时留空 —— 显示 0.2 会把"没配"变成"配成 0.2"', () => {
    loadSettings({ temperature: null, maxTokens: null });
    expect(document.getElementById('inp-temperature').value).toBe('');
    expect(document.getElementById('inp-max-tokens').value).toBe('');
  });

  it('填写后随 settings.apply 提交为数字', () => {
    loadSettings({});
    document.getElementById('inp-temperature').value = '1.2';
    document.getElementById('inp-max-tokens').value = '4096';
    const sent = submit();
    expect(sent.temperature).toBe(1.2);
    expect(sent.maxTokens).toBe(4096);
  });

  it('留空的判据是"空串"而不是"假值"：显式填 0 必须原样提交', () => {
    loadSettings({});
    document.getElementById('inp-temperature').value = '';
    document.getElementById('inp-max-tokens').value = '';
    const sent = submit();
    expect(sent.temperature).toBeUndefined();
    expect(sent.maxTokens).toBeUndefined();

    // 温度 0 = 最确定，是**合法值**；用 `if (x)` 判断真假会把它当成"没填"而丢掉
    document.getElementById('inp-temperature').value = '0';
    expect(submit().temperature).toBe(0);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
});

/**
 * 会话回滚（P2-6）的结果是**多行**系统消息：分项汇报「还原 / 删除 / 跳过 / 失败」。
 *
 * 只断言 JS 写进 DOM 的话，只能证明文本到了 —— 真正决定用户能不能看出分类的是样式表：
 * `.message.system` 少一条 `white-space: pre-line`，HTML 就会把换行折叠成空格，
 * 六类信息糊成一整行，而这个功能在 UI 上的**全部价值**就是把它们分清楚。
 * 所以两半都要钉：CSS 有那条规则 + DOM 真的命中它。
 */
describe('会话回滚结果的多行汇报', () => {
  const css = readFileSync(path.join(repoRoot, 'media', 'webview.css'), 'utf8');

  it('样式表声明了系统消息保留换行', () => {
    expect(css).toMatch(/\.message\.system\s*\{[^}]*white-space:\s*pre-line/);
  });

  it('notice 的多行文本原样落到 .message.system 且命中该规则', () => {
    emitRaw({ kind: 'session.reset', sessionId: 'sess_rollback_ui', reason: 'new' });
    emitEvent('notice', {
      text:
        '已回滚 2 处文件改动，另有 1 处未处理\n' +
        '- 还原为改动前：a.ts、b.ts\n' +
        '- 跳过 1 个（编辑器里有未保存的改动）：c.ts。请先保存或放弃这些改动后再回滚。',
    });

    const nodes = [...document.querySelectorAll('.message.system')];
    const last = nodes[nodes.length - 1];
    // 换行必须真的在文本里（而不是被谁先做了 replace）
    expect(last.textContent.split('\n')).toHaveLength(3);
    expect(last.textContent).toContain('跳过 1 个');
    expect(last.matches('.message.system')).toBe(true);
  });
});

/**
 * Plan 模式（P2-7）：计划卡是"整轮做不做"的闸门，它的三条设计决策都要钉住 ——
 *  ① 计划正文按 Markdown 渲染（计划里必然有编号步骤与路径，渲成纯文本等于让它不可读）；
 *  ② 挂起时必须展开（与审批卡同一条"挂起项必须展开"的约定），决策后才折叠；
 *  ③ 批准时携带的补充意见必须真的发出去 —— 那个输入框存在的唯一理由就是这个。
 *  ④ 标题写主题、徽标写结论：卡片折叠后只剩标题行，若标题本身写着"待批准"，
 *     决策后就会出现"待批准 + 不同意"这种自相矛盾的残留（审批/补丁卡都遵守这条）。
 */
describe('Plan 模式：计划卡', () => {
  const css = readFileSync(path.join(repoRoot, 'media', 'webview.css'), 'utf8');

  function requestPlan(planId) {
    emitRaw({ kind: 'session.reset', sessionId: 'sess_plan_' + planId, reason: 'new' });
    emitEvent('plan.request', {
      planId,
      plan: '## 计划\n\n1. 目标：改 `a.ts`。\n2. 步骤：读取 -> 打补丁。',
      expiresAt: Date.now() + 60_000,
    });
    return document.querySelector('.card.plan:last-of-type') || document.querySelector('.card.plan');
  }

  it('计划正文按 Markdown 渲染，且决策后正文命中折叠规则', () => {
    const card = requestPlan('plan_css');
    // 标题与有序列表都要真的成为元素，而不是留在文本里的 #、1.
    expect(card.querySelectorAll('.card-md h2').length).toBeGreaterThan(0);
    expect(card.querySelectorAll('.card-md ol li').length).toBeGreaterThan(0);

    const body = card.querySelector('.card-body');
    expect(body.matches('.card.collapsed > .card-body')).toBe(false);

    [...card.querySelectorAll('.card-actions button')].find((b) => b.textContent === '不同意').click();
    expect(body.matches('.card.collapsed > .card-body')).toBe(true);
  });

  it('样式表声明了计划卡的主色边与正文高度上限', () => {
    expect(css).toMatch(/\.card\.plan\s*\{[^}]*border-left-color:\s*var\(--dsh-accent\)/);
    expect(css).toMatch(/\.card-md\s*\{[^}]*max-height/);
    expect(css).toMatch(/\.mode-toggle\.on\s*\{[^}]*background:\s*var\(--dsh-accent\)/);
  });

  it('批准时带上补充意见，且决策后输入框被收起', () => {
    const card = requestPlan('plan_note');
    const note = card.querySelector('.card-note textarea');
    note.value = '  第 2 步不要动 b.ts  ';
    [...card.querySelectorAll('.card-actions button')].find((b) => b.textContent === '批准并执行').click();

    const sent = lastMessageOfKind('plan.respond');
    expect(sent.planId).toBe('plan_note');
    expect(sent.approved).toBe(true);
    expect(sent.note).toBe('第 2 步不要动 b.ts');
    // 决策后再留一个还能打字、内容却再也送不出去的框，用户会以为意见已生效
    expect(card.querySelector('.card-note').hidden).toBe(true);
  });

  it('不同意时不带 note，且待办条能直接批准（计划优先于审批显示）', () => {
    const card = requestPlan('plan_bar');
    const barBtn = pendingButton('批准并执行');
    expect(barBtn).toBeTruthy();
    pendingButton('不同意').click();
    const sent = lastMessageOfKind('plan.respond');
    expect(sent.planId).toBe('plan_bar');
    expect(sent.approved).toBe(false);
    expect(sent.note).toBeUndefined();
    expect(card.querySelector('.badge').textContent).toBe('不同意');
  });

  it('标题写主题、徽标写结论（决策后标题不会和徽标打架）', () => {
    const card = requestPlan('plan_title');
    const title = card.querySelector('.card-title b');
    expect(title.textContent).toContain('计划方案');
    // 标题不是状态：决策前后都必须保持同一个主题词
    expect(title.textContent).not.toContain('待批准');

    // 挂起中：结论交给徽标
    expect(card.querySelector('.badge').textContent).toBe('待批准');

    [...card.querySelectorAll('.card-actions button')].find((b) => b.textContent === '批准并执行').click();
    expect(card.querySelector('.badge').textContent).toBe('已批准');
    expect(card.querySelector('.card-title b').textContent).toContain('计划方案');
  });

  it('计划模式的开关随 send 一起提交（它是"这条怎么发"，不是全局设置）', () => {
    emitRaw({ kind: 'session.reset', sessionId: 'sess_plan_toggle', reason: 'new' });
    const toggle = document.getElementById('btn-plan-mode');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');

    // 关着的时候不能带上 planMode（缺省行为必须逐字节不变）
    document.getElementById('input').value = '看一下 a.ts';
    document.getElementById('btn-send').click();
    expect(lastMessageOfKind('send').planMode).toBe(false);

    // send() 会把输入区置为 running 并挡住重复提交，先结束这一轮才能再发一条
    emitEvent('session.ended', { reason: 'completed' });

    toggle.click();
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    document.getElementById('input').value = '再改一下 a.ts';
    document.getElementById('btn-send').click();
    expect(lastMessageOfKind('send').planMode).toBe(true);
    expect(toggle.className).toContain('on');
  });

  it('用户气泡带「计划模式」chip（事后回看要能看出这条为什么先出计划）', () => {
    emitRaw({ kind: 'session.reset', sessionId: 'sess_plan_chip', reason: 'new' });
    emitEvent('user.message', { text: '改一下 a.ts', attachments: [], planMode: true });
    const chips = [...document.querySelectorAll('.chip.chip-plan')];
    expect(chips.length).toBe(1);
    expect(chips[0].textContent).toBe('计划模式');
  });
});

/**
 * 图片输入（P2-4）。
 *
 * 这里的断言对准的是**用户真的能完成的动作**：选文件 / 拖进来 / 粘贴 -> 看得见缩略图 ->
 * 能删掉 -> 发得出去。三条输入路径必须汇到同一处暂存（否则限额与降采样就会出现两份实现），
 * 而"发出去的是什么"必须与"面板显示的是什么"分开说清楚：载荷里只有 base64 与 clientId，
 * 缩略图（data URL）**不回传**扩展 —— 来回搬一趟等于把几 MB 的图片复制进消息桥。
 *
 * jsdom 下 `canProcessImages()` 判为 false（没有真的 canvas/解码），于是这里走的是
 * "原样发送"分支 —— 正好也把这条降级路径锁住了：解码不可用时功能不能整个消失。
 */
describe('图片输入（批次 6）', () => {
  const css = readFileSync(path.join(repoRoot, 'media', 'webview.css'), 'utf8');
  const staging = () => document.getElementById('image-staging');
  const notice = () => document.getElementById('composer-notice');
  const thumbs = () => [...staging().querySelectorAll('.image-thumb')];
  const inputEl = () => document.getElementById('input');
  /** 最后一条用户回合：角色标记、正文气泡、chip 行都挂在同一个 `.turn.user` 上。 */
  const lastUserTurn = () => {
    const turns = [...document.querySelectorAll('.turn.user')];
    return turns[turns.length - 1];
  };

  async function waitFor(fn, what, timeout = 3000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (fn()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('等待超时：' + what);
  }

  /** 结束当前回合，保证 send() 不会因为"上一轮还在跑"而静默返回。 */
  function idle() {
    emitEvent('session.ended', { reason: 'completed' });
    inputEl().value = '';
  }

  /** 造一个图片 File（jsdom 的 File/FileReader 是真的，能给出真 data URL）。 */
  const png = (name = 'shot.png') => new File(['\u0089PNG'], name, { type: 'image/png' });

  /** 模拟"选择文件"：jsdom 里 fileInput.files 只读，只能顶替掉。 */
  async function selectFiles(...files) {
    const input = document.getElementById('file-input');
    notice().hidden = true; // 上一次的提示可能还挂着，避免误判"已完成"
    Object.defineProperty(input, 'files', { configurable: true, value: files });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => thumbs().length > 0 || !notice().hidden, '文件被暂存（或给出拒绝原因）');
  }

  it('骨架：附件按钮 / 隐藏文件输入 / 暂存区 / 提示区都在，且 accept 与协议白名单一致', () => {
    const btn = document.getElementById('btn-attach');
    const file = document.getElementById('file-input');
    expect(btn).not.toBeNull();
    expect(file).not.toBeNull();
    expect(file.type).toBe('file');
    expect(file.multiple).toBe(true);
    // 选择器不限死单张：多张图一次选中是常见动作，限额判定在暂存时统一做
    expect(file.accept).toBe('image/png,image/jpeg,image/webp,image/gif');
    expect(staging()).not.toBeNull();
    expect(staging().hidden).toBe(true); // 没图时收起，不占高度
    expect(notice()).not.toBeNull();
    expect(notice().hidden).toBe(true);
  });

  it('可发现性：输入框的悬停提示说明了"能粘贴 / 能拖进来"', () => {
    const title = inputEl().getAttribute('title') || '';
    expect(title).toContain('粘贴');
    expect(title).toContain('拖');
  });

  it('DOM ↔ CSS 契约：chip 对齐与三类图片元素的规则都在样式表里', () => {
    // 图片 chip 高得多，默认 stretch 会把相邻文字 chip 抻成同高的椭圆（曾实际出现）
    expect(css).toMatch(/\.chips[ \t]*\{[^}]*align-items:[ \t]*center/);
    expect(css).toMatch(/\.image-staging[ \t]*\{[^}]*display:[ \t]*flex/);
    expect(css).toMatch(/\.image-thumb[ \t]*\{[^}]*position:[ \t]*relative/);
    expect(css).toMatch(/\.image-remove[ \t]*\{[^}]*position:[ \t]*absolute/);
    // 用户气泡里的图片 chip：直接画缩略图，不写字
    expect(css).toMatch(/\.chip\.chip-image[ \t]+img[ \t]*\{[^}]*object-fit:[ \t]*cover/);
    // 拖放悬停要有反馈，否则用户不敢松手
    expect(css).toMatch(/\.composer-box\.drop-target[ \t]*\{[^}]*box-shadow/);
  });

  it('文件选择：暂存出缩略图，data URL 直接可用（jsdom 无 canvas 时走原样发送）', async () => {
    idle();
    await selectFiles(png('报错截图.png'));

    expect(staging().hidden).toBe(false);
    expect(thumbs()).toHaveLength(1);
    const pic = thumbs()[0].querySelector('img');
    expect(pic.src.startsWith('data:image/png;base64,')).toBe(true);
    expect(pic.alt).toBe('报错截图.png');
    // 体积是算出来的（'<89>PNG' = 4 字节），提示里带名字与体积
    expect(pic.title).toContain('报错截图.png');
    // 没有真的降采样时更要能删：移除按钮是唯一退路
    expect(thumbs()[0].querySelector('.image-remove').getAttribute('aria-label')).toBe('移除 报错截图.png');
  });

  it('移除：点 × 之后缩略图消失，暂存区收起', async () => {
    thumbs()[0].querySelector('.image-remove').click();
    expect(thumbs()).toHaveLength(0);
    expect(staging().hidden).toBe(true);
  });

  it('格式不支持：不暂存、但**必须说出来**（静默忽略会让用户以为已经附上了）', async () => {
    idle();
    await selectFiles(new File(['x'], 'logo.svg', { type: 'image/svg+xml' }));
    expect(thumbs()).toHaveLength(0);
    expect(notice().hidden).toBe(false);
    expect(notice().textContent).toContain('不支持');
    expect(notice().textContent).toContain('logo.svg');
  });

  it('只发图不写字：载荷里只有 base64 与 clientId，缩略图不来回搬', async () => {
    idle();
    await selectFiles(png());
    posted.length = 0;
    document.getElementById('btn-send').click();

    const send = lastMessageOfKind('send');
    expect(send).toBeTruthy();
    expect(send.prompt).toBe('');
    expect(send.images).toHaveLength(1);
    expect(send.images[0].mimeType).toBe('image/png');
    expect(send.images[0].clientId).toBeTruthy();
    // dataBase64 是裸 base64，不是 data URL（前缀由 daemon 侧按 provider 拼）
    expect(send.images[0].dataBase64.startsWith('data:')).toBe(false);
    // 缩略图留在面板本地
    expect('previewUrl' in send.images[0]).toBe(false);
  });

  it('发送后暂存**不**立即清空；等扩展回显才提交，并把缩略图画进用户气泡', async () => {
    const send = lastMessageOfKind('send');
    const clientId = send.images[0].clientId;

    // 关键顺序：点发送就清空的话，扩展一旦拒绝（超限），用户就得重新粘一遍，
    // 而那张图往往正是问题本身。所以先保持原样。
    expect(thumbs()).toHaveLength(1);

    emitEvent('user.message', { text: '', attachments: [{ label: '🖼 shot.png', imageId: clientId }] });

    expect(thumbs()).toHaveLength(0);
    expect(staging().hidden).toBe(true);
    // chip 行与正文气泡同属一个 .turn.user（不是塞进气泡里），故取最后一条用户回合
    const chip = lastUserTurn().querySelector('.chip.chip-image');
    expect(chip).not.toBeNull();
    expect(chip.querySelector('img').src.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('拿不到缩略图时退回文字 chip（历史重放不显示破图）', () => {
    emitEvent('user.message', {
      text: '看下这个',
      attachments: [{ label: '🖼 旧图.png', imageId: 'img_不存在的会话' }],
    });
    const turn = lastUserTurn();
    expect(turn.querySelector('.chip-image')).toBeNull();
    expect([...turn.querySelectorAll('.chip')].map((n) => n.textContent)).toEqual(['🖼 旧图.png']);
  });

  it('纯文字 chip 不受影响（回归：图片能力不能改掉既有的上下文回显）', () => {
    emitEvent('user.message', { text: '改这里', attachments: [{ label: 'app.ts' }, { label: '选区 L12-30' }] });
    const turn = lastUserTurn();
    expect([...turn.querySelectorAll('.chip')].map((n) => n.textContent)).toEqual(['app.ts', '选区 L12-30']);
  });

  it('拖放：有图片才有悬停反馈，落下走的是同一条暂存通路', async () => {
    idle();
    const box = document.getElementById('composer-box');
    const dragEvent = (type, files) => {
      const ev = new Event(type, { bubbles: true, cancelable: true });
      ev.dataTransfer = { files, dropEffect: '' };
      return ev;
    };

    // 纯文本拖放不该给"会附上图片"的假反馈
    box.dispatchEvent(dragEvent('dragover', []));
    expect(box.classList.contains('drop-target')).toBe(false);

    box.dispatchEvent(dragEvent('dragover', [png('拖进来的.png')]));
    expect(box.classList.contains('drop-target')).toBe(true);

    box.dispatchEvent(dragEvent('drop', [png('拖进来的.png')]));
    await waitFor(() => thumbs().length === 1, '拖放的图片被暂存');
    expect(box.classList.contains('drop-target')).toBe(false);
    expect(thumbs()[0].querySelector('img').alt).toBe('拖进来的.png');
    thumbs()[0].querySelector('.image-remove').click();
  });

  it('粘贴：剪贴板里有图片才接管，纯文本粘贴完全不动', async () => {
    idle();
    const paste = () => {
      const ev = new Event('paste', { bubbles: true, cancelable: true });
      return ev;
    };
    // 纯文本：既不暂存，也不干扰浏览器把文字贴进输入框
    const text = paste();
    text.clipboardData = { files: [], items: [] };
    inputEl().dispatchEvent(text);
    expect(thumbs()).toHaveLength(0);

    const shot = paste();
    shot.clipboardData = { files: [png('截图.png')], items: [] };
    inputEl().dispatchEvent(shot);
    await waitFor(() => thumbs().length === 1, '粘贴的截图被暂存');
    expect(thumbs()[0].querySelector('img').alt).toBe('截图.png');
    thumbs()[0].querySelector('.image-remove').click();
  });

  it('新会话清空暂存（上一轮没发出去的图不会跨会话跟过来）', async () => {
    idle();
    await selectFiles(png('半途而废.png'));
    expect(thumbs()).toHaveLength(1);
    emitRaw({ kind: 'session.reset', sessionId: 'sess_img_reset', reason: 'new' });
    expect(thumbs()).toHaveLength(0);
    expect(staging().hidden).toBe(true);
  });
});

/**
 * P2-8 结构化轨迹的呈现契约。
 *
 * 关键约束是**向后兼容**：旧记录（只有 step/kind/detail）必须渲染得和以前一模一样，
 * 不能凭空多出一个空徽标节点 —— `.trajectory` 里每个多余节点都会影响窄栏排版。
 */
describe('结构化轨迹（P2-8）', () => {
  const css = readFileSync(path.join(repoRoot, 'media', 'webview.css'), 'utf8');
  const trajLines = () => Array.from(document.querySelectorAll('#trajectory .traj-line'));
  const lastLine = () => trajLines()[trajLines().length - 1];

  it('失败记录：行尾出现错误分类徽标，并标记为警示色', () => {
    emitEvent('trajectory.record', {
      step: 901,
      kind: 'tool',
      detail: 'bash_execute 策略拒绝：命令命中拒绝规则',
      tool: 'bash_execute',
      ok: false,
      durationMs: 12,
      errorKind: 'policy-denied',
    });
    const meta = lastLine().querySelector('.traj-meta');
    expect(meta).not.toBeNull();
    expect(meta.classList.contains('is-fail')).toBe(true);
    expect(meta.textContent).toContain('失败');
    expect(meta.textContent).toContain('policy-denied');
    expect(meta.textContent).toContain('12ms');
  });

  it('成功记录：只给耗时，不打失败标记', () => {
    emitEvent('trajectory.record', {
      step: 902,
      kind: 'tool',
      detail: 'read_file 完成',
      tool: 'read_file',
      ok: true,
      durationMs: 1500,
    });
    const meta = lastLine().querySelector('.traj-meta');
    expect(meta).not.toBeNull();
    expect(meta.classList.contains('is-fail')).toBe(false);
    expect(meta.textContent).toBe('1.5s');
  });

  it('token 记录：估算值带 ≈ 前缀（不被当账单读）', () => {
    emitEvent('trajectory.record', {
      step: 903,
      kind: 'system',
      detail: 'model 调用（约 150 token）',
      tokens: { prompt: 100, completion: 50, total: 150, estimated: true },
    });
    const meta = lastLine().querySelector('.traj-meta');
    expect(meta.textContent).toContain('≈150 tok');
  });

  it('无结构化字段的旧记录：不产生徽标节点（渲染与拆分前一致）', () => {
    emitEvent('trajectory.record', { step: 904, kind: 'reasoning', detail: '思考中' });
    const line = lastLine();
    expect(line.querySelector('.traj-meta')).toBeNull();
    // 三个 span：步号 / 类型 / 正文
    expect(line.children).toHaveLength(3);
    expect(line.textContent).toContain('思考中');
  });

  it('durationMs 为 0：不显示耗时（0ms 是噪音，不是信息）', () => {
    emitEvent('trajectory.record', {
      step: 905,
      kind: 'tool',
      detail: 'bash_execute 完成',
      tool: 'bash_execute',
      ok: true,
      durationMs: 0,
    });
    expect(lastLine().querySelector('.traj-meta')).toBeNull();
  });

  it('DOM ↔ CSS 契约：徽标规则与警示色规则都在样式表里', () => {
    // 徽标要能推到行尾并与正文分离，否则长 detail 会把耗时挤到看不见
    expect(css).toMatch(/\.traj-meta[ \t]*\{[^}]*margin-left:[ \t]*auto/);
    expect(css).toMatch(/\.traj-meta[ \t]*\{[^}]*white-space:[ \t]*nowrap/);
    expect(css).toMatch(/\.traj-meta\.is-fail[ \t]*\{[^}]*color:[ \t]*var\(--dsh-err\)/);
    // 正文必须可收缩 + 可任意断行：缺这两条时，长命令原文会把行尾徽标挤出 340px 窄栏
    // （实测截图确认过，不是理论担忧）。行本身要允许换行，否则徽标只能靠挤压正文来容身。
    expect(css).toMatch(/\.traj-detail[ \t]*\{[^}]*flex:[ \t]*0[ \t]+1[ \t]+auto/);
    expect(css).toMatch(/\.traj-detail[ \t]*\{[^}]*min-width:[ \t]*0/);
    expect(css).toMatch(/\.traj-detail[ \t]*\{[^}]*overflow-wrap:[ \t]*anywhere/);
    expect(css).toMatch(/\.traj-line[ \t]*\{[^}]*flex-wrap:[ \t]*wrap/);
  });

  it('正文节点带 traj-detail 类（否则上面的收缩规则落不到实处）', () => {
    emitEvent('trajectory.record', {
      step: 906,
      kind: 'tool',
      detail: 'bash_execute 策略拒绝：/\\brm\\s+(-rf|-fr)\\b/i',
      tool: 'bash_execute',
      ok: false,
      durationMs: 3,
      errorKind: 'policy-denied',
    });
    const line = lastLine();
    expect(line.querySelector('.traj-detail')).not.toBeNull();
    expect(line.querySelector('.traj-detail').textContent).toContain('策略拒绝');
  });
});
