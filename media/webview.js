/* dsh Agent Webview UI（vanilla JS，无框架依赖）。
 * 经 esbuild 打包：本文件为 bundle 入口，import 的 Markdown 渲染模块会内联其中。 */
import { renderMarkdown } from '../src/webview/render.js';

(function () {
  'use strict';

  // eslint-disable-next-line no-undef
  const vscode = acquireVsCodeApi();

  const $ = (id) => document.getElementById(id);
  const messagesEl = $('messages');
  const emptyEl = $('empty');
  const statusEl = $('status');
  const inputEl = $('input');
  const btnSend = $('btn-send');
  const btnCancel = $('btn-cancel');
  const btnClear = $('btn-clear');
  const sessionEl = $('session-id');
  const trajectoryBox = $('trajectory-box');
  const trajectoryEl = $('trajectory');

  let running = false;
  let reasoningEl = null;
  let assistantEl = null;
  const toolCards = new Map(); // tool -> card element
  const patchCards = new Map(); // patchId -> card element
  const approvalCards = new Map(); // approvalId -> card element
  const approvalTimers = new Map(); // approvalId -> interval id

  // -------------------------------------------------------------------------
  // DOM 工具
  // -------------------------------------------------------------------------

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function scrollBottom() {
    const main = document.getElementById('main');
    main.scrollTop = main.scrollHeight;
  }

  function addMessage(node) {
    emptyEl.style.display = 'none';
    messagesEl.appendChild(node);
    scrollBottom();
    return node;
  }

  function setStatus(status, detail) {
    statusEl.className = 'status ' + (status || '');
    const label = status || 'unknown';
    statusEl.textContent = detail ? label + ' — ' + detail : label;
    statusEl.title = detail || '';
  }

  function setRunning(r) {
    running = r;
    btnSend.disabled = r;
    btnCancel.hidden = !r;
    btnSend.textContent = r ? '处理中…' : '发送';
  }

  // -------------------------------------------------------------------------
  // 消息渲染
  // -------------------------------------------------------------------------

  function addUser(text) {
    const node = el('div', 'message user');
    // 用户消息同样按 Markdown 渲染，但只允许「已净化」的 HTML 进入 innerHTML
    node.innerHTML = renderMarkdown(text);
    addMessage(node);
    return node;
  }

  function addSystem(text) {
    addMessage(el('div', 'message system', text));
  }

  function addError(text) {
    addMessage(el('div', 'message error', '⚠ ' + text));
  }

  function ensureReasoning() {
    if (reasoningEl) return;
    const details = el('details', 'message reasoning');
    details.open = true;
    details.appendChild(el('summary', '', '🧠 推理过程（Reasoning Stream）'));
    reasoningEl = el('pre', '', '');
    details.appendChild(reasoningEl);
    addMessage(details);
  }

  function appendReasoning(delta) {
    ensureReasoning();
    reasoningEl.textContent += delta;
    scrollBottom();
  }

  function ensureAssistant() {
    if (assistantEl) return;
    assistantEl = el('div', 'message assistant');
    addMessage(assistantEl);
  }

  // 流式期间累积纯文本（廉价、安全）；仅在此处一次性渲染为已净化的 Markdown
  function appendAssistant(delta) {
    ensureAssistant();
    assistantEl.textContent += delta;
    scrollBottom();
  }

  function finishAssistant() {
    if (assistantEl) {
      const raw = assistantEl.textContent;
      assistantEl.innerHTML = renderMarkdown(raw);
    }
    assistantEl = null;
    reasoningEl = null;
  }

  // -------------------------------------------------------------------------
  // 工具卡
  // -------------------------------------------------------------------------

  function addToolCard(tool, input) {
    if (toolCards.has(tool)) return;
    const card = el('div', 'card');
    const title = el('div', 'card-title');
    title.appendChild(el('span', '', '⚙ ' + tool));
    title.appendChild(el('span', 'badge running', 'running'));
    const body = el('div', 'card-body', JSON.stringify(input ?? {}, null, 2));
    card.appendChild(title);
    card.appendChild(body);
    addMessage(card);
    toolCards.set(tool, card);
  }

  function updateToolCard(tool, executed) {
    const card = toolCards.get(tool);
    if (!card) return;
    const badge = card.querySelector('.badge');
    badge.className = 'badge ' + (executed.ok ? 'ok' : 'err');
    badge.textContent = executed.ok ? 'ok' : 'failed';
    const body = el('div', 'card-body', executed.output ?? '(无输出)');
    card.appendChild(body);
    toolCards.delete(tool);
    scrollBottom();
  }

  // -------------------------------------------------------------------------
  // 审批卡（Human-in-the-Loop）
  // -------------------------------------------------------------------------

  function addApprovalCard(p) {
    const card = el('div', 'card');
    const title = el('div', 'card-title');
    title.appendChild(el('span', '', '⚠ 工具审批'));
    title.appendChild(el('span', 'badge risk-' + (p.risk || 'medium'), p.risk || 'medium'));
    title.appendChild(el('span', '', p.tool));
    card.appendChild(title);

    const body = el('div', 'card-body', JSON.stringify(p.input ?? {}, null, 2));
    card.appendChild(body);
    card.appendChild(el('div', '', p.reason || ''));

    // 过期倒计时（P1.1）：expiresAt 到达后自动置灰
    let timerInfo = null;
    if (p.expiresAt) {
      const countdown = el('div', 'muted', '');
      card.appendChild(countdown);
      const tick = () => {
        const remain = Math.max(0, Math.ceil((p.expiresAt - Date.now()) / 1000));
        if (remain <= 0) {
          countdown.textContent = '⏱ 已过期（按拒绝处理）';
          markExpired();
          clearInterval(interval);
          approvalTimers.delete(p.approvalId);
          return;
        }
        countdown.textContent = '⏱ 剩余 ' + remain + 's';
      };
      const interval = setInterval(tick, 1000);
      approvalTimers.set(p.approvalId, interval);
      tick();
      timerInfo = { countdown, interval };
    }

    const actions = el('div', 'card-actions');
    const btnReject = el('button', 'danger', '拒绝');
    const btnAccept = el('button', 'ok-btn', '接受');
    function markExpired() {
      btnAccept.disabled = btnReject.disabled = true;
      const badge = card.querySelector('.badge');
      if (badge) {
        badge.className = 'badge err';
        badge.textContent = 'expired';
      }
      if (timerInfo) timerInfo.countdown.textContent = '⏱ 已过期（按拒绝处理）';
    }
    btnReject.addEventListener('click', () => {
      vscode.postMessage({ kind: 'approval.respond', approvalId: p.approvalId, approved: false });
      btnAccept.disabled = btnReject.disabled = true;
      stopTimer();
    });
    btnAccept.addEventListener('click', () => {
      vscode.postMessage({ kind: 'approval.respond', approvalId: p.approvalId, approved: true });
      btnAccept.disabled = btnReject.disabled = true;
      stopTimer();
    });
    function stopTimer() {
      const t = approvalTimers.get(p.approvalId);
      if (t) {
        clearInterval(t);
        approvalTimers.delete(p.approvalId);
      }
    }
    actions.appendChild(btnReject);
    actions.appendChild(btnAccept);
    card.appendChild(actions);
    addMessage(card);
    approvalCards.set(p.approvalId, card);
  }

  function expireApprovalCard(approvalId) {
    const card = approvalCards.get(approvalId);
    const t = approvalTimers.get(approvalId);
    if (t) {
      clearInterval(t);
      approvalTimers.delete(approvalId);
    }
    if (card) {
      const badge = card.querySelector('.badge');
      if (badge) {
        badge.className = 'badge err';
        badge.textContent = '已过期';
      }
      const countdown = card.querySelector('.muted');
      if (countdown) countdown.textContent = '⏱ 已过期（按拒绝处理）';
      card.querySelectorAll('button').forEach((b) => (b.disabled = true));
    }
  }

  function removeApprovalCard(approvalId) {
    const t = approvalTimers.get(approvalId);
    if (t) {
      clearInterval(t);
      approvalTimers.delete(approvalId);
    }
    const card = approvalCards.get(approvalId);
    if (card) {
      card.querySelectorAll('button').forEach((b) => (b.disabled = true));
    }
  }

  // -------------------------------------------------------------------------
  // 文件补丁卡（Native Diff 预览入口）
  // -------------------------------------------------------------------------

  function addPatchCard(p) {
    const card = el('div', 'card');
    const title = el('div', 'card-title');
    title.appendChild(el('span', '', '📝 文件补丁'));
    title.appendChild(el('span', 'badge running', 'pending'));
    card.appendChild(title);
    card.appendChild(el('div', '', p.path));
    if (p.description) card.appendChild(el('div', 'card-body', p.description));

    const actions = el('div', 'card-actions');
    const btnDiff = el('button', 'ghost', '打开 Diff');
    const btnReject = el('button', 'danger', '拒绝');
    const btnAccept = el('button', 'ok-btn', '应用');
    btnDiff.addEventListener('click', () => {
      vscode.postMessage({ kind: 'patch.openDiff', patchId: p.patchId });
    });
    btnReject.addEventListener('click', () => {
      vscode.postMessage({ kind: 'patch.reject', patchId: p.patchId });
      btnAccept.disabled = btnReject.disabled = btnDiff.disabled = true;
    });
    btnAccept.addEventListener('click', () => {
      vscode.postMessage({ kind: 'patch.accept', patchId: p.patchId });
      btnAccept.disabled = btnReject.disabled = btnDiff.disabled = true;
    });
    actions.appendChild(btnDiff);
    actions.appendChild(btnReject);
    actions.appendChild(btnAccept);
    card.appendChild(actions);
    addMessage(card);
    patchCards.set(p.patchId, card);
  }

  function updatePatchCard(result) {
    const card = patchCards.get(result.patchId);
    if (!card) return;
    const badge = card.querySelector('.badge');
    if (result.applied) {
      badge.className = 'badge ok';
      badge.textContent = '已应用';
    } else if (result.accepted && result.error) {
      badge.className = 'badge err';
      badge.textContent = '应用失败';
      card.appendChild(el('div', 'card-body', result.error));
    } else {
      badge.className = 'badge err';
      badge.textContent = '已拒绝';
    }
    card.querySelectorAll('button').forEach((b) => (b.disabled = true));
    patchCards.delete(result.patchId);
    scrollBottom();
  }

  // -------------------------------------------------------------------------
  // 迹线
  // -------------------------------------------------------------------------

  function addTrajectory(t) {
    trajectoryBox.hidden = false;
    const line = el('div', 'traj-line');
    line.appendChild(el('span', 'traj-step', '#' + t.step));
    line.appendChild(el('span', 'traj-kind', t.kind));
    line.appendChild(el('span', '', t.detail));
    trajectoryEl.appendChild(line);
    trajectoryBox.open = true;
  }

  // -------------------------------------------------------------------------
  // 事件分发（extension -> webview）
  // -------------------------------------------------------------------------

  function handleEvent(method, params) {
    switch (method) {
      case 'user.message':
        addUser(params.text);
        break;
      case 'session.started':
        setRunning(true);
        sessionEl.textContent = 'session: ' + params.sessionId;
        addSystem('会话开始' + (params.title ? '：' + params.title : ''));
        break;
      case 'reasoning.delta':
        appendReasoning(params.delta);
        break;
      case 'message.delta':
        appendAssistant(params.delta);
        break;
      case 'message.done':
        finishAssistant();
        break;
      case 'tool.started':
        addToolCard(params.tool, params.input);
        break;
      case 'tool.executed':
        updateToolCard(params.tool, params);
        break;
      case 'approval.request':
        addApprovalCard(params);
        break;
      case 'approval.expired':
        expireApprovalCard(params.approvalId);
        break;
      case 'approval.responded':
        removeApprovalCard(params.approvalId);
        break;
      case 'file.patch.pending':
        addPatchCard(params);
        break;
      case 'file.patch.result':
        updatePatchCard(params);
        break;
      case 'trajectory.record':
        addTrajectory(params);
        break;
      case 'session.ended':
        setRunning(false);
        finishAssistant();
        addSystem('会话结束（' + (params.reason || 'completed') + '）');
        break;
      case 'error':
        setRunning(false);
        addError(params.message);
        break;
      default:
        break;
    }
  }

  window.addEventListener('message', (e) => {
    const msg = e.data || {};
    switch (msg.kind) {
      case 'status':
        setStatus(msg.status, msg.detail);
        break;
      case 'init':
        sessionEl.textContent = msg.state && msg.state.sessionId ? 'session: ' + msg.state.sessionId : '';
        if (msg.state && msg.state.connected) setStatus('connected', '');
        break;
      case 'event':
        handleEvent(msg.method, msg.params);
        break;
      default:
        break;
    }
  });

  // -------------------------------------------------------------------------
  // 用户交互（webview -> extension）
  // -------------------------------------------------------------------------

  function send() {
    const text = inputEl.value.trim();
    if (!text || running) return;
    addUser(text);
    inputEl.value = '';
    setRunning(true);
    vscode.postMessage({ kind: 'send', prompt: text });
  }

  btnSend.addEventListener('click', send);
  btnCancel.addEventListener('click', () => {
    vscode.postMessage({ kind: 'cancel' });
  });
  btnClear.addEventListener('click', () => {
    messagesEl.innerHTML = '';
    emptyEl.style.display = '';
    trajectoryEl.innerHTML = '';
    trajectoryBox.hidden = true;
    toolCards.clear();
    patchCards.clear();
    approvalCards.clear();
    for (const t of approvalTimers.values()) clearInterval(t);
    approvalTimers.clear();
    reasoningEl = null;
    assistantEl = null;
    sessionEl.textContent = '';
    setRunning(false);
  });

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  // 通知扩展：面板已就绪
  vscode.postMessage({ kind: 'ready' });
})();
