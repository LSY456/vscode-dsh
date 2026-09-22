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
    expect(agentEl.textContent).toBe('real · deepseek-chat');
    expect(document.getElementById('session-id').textContent).toContain('sess_abcdef');
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

  it('失败的步骤自动展开输出', () => {
    emitEvent('tool.started', { tool: 'bash_execute', input: { command: 'rm -rf /' } });
    emitEvent('tool.executed', { tool: 'bash_execute', ok: false, output: '命令被拒绝', durationMs: 3 });
    const rows = document.querySelectorAll('.activity .tool-row');
    expect(rows.length).toBe(2);
    expect(rows[1].className).toContain('failed');
    expect(rows[1].className).toContain('open');
    expect(rows[1].textContent).toContain('命令被拒绝');
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
    expect(document.querySelector('.badge.err').textContent).toBe('已过期');
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

  it('session.reset(new)：清空视图、更新会话号并提示', () => {
    const before = document.querySelectorAll('.message.user').length;
    emitEvent('user.message', { text: '旧会话里的问题' });
    expect(document.querySelectorAll('.message.user').length).toBe(before + 1);
    emitRaw({ kind: 'session.reset', sessionId: 'sess_new_0001', reason: 'new' });
    expect(document.querySelectorAll('.message.user').length).toBe(0);
    expect(document.getElementById('session-id').textContent).toContain('sess_new_000');
    expect(document.querySelector('.message.system').textContent).toContain('已新建会话');
  });

  it('session.reset(switch)：提示已切换且可继续对话', () => {
    emitRaw({ kind: 'session.reset', sessionId: 'sess_old_0002', reason: 'switch' });
    const texts = [...document.querySelectorAll('.message.system')].map((n) => n.textContent);
    expect(texts.some((t) => t.includes('已切换到会话'))).toBe(true);
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
});
