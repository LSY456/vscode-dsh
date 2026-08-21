/* dsh Agent Webview UI（vanilla JS，无框架依赖）。
 * 经 esbuild 打包：本文件为 bundle 入口，import 的 Markdown 渲染模块会内联其中。 */
import { renderMarkdown } from '../src/webview/render.js';
import { createBatcher } from '../src/webview/streamBatcher.js';

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
  const btnHistory = $('btn-history');
  const historyPanel = $('history-panel');
  const historyList = $('history-list');
  const btnSettings = $('btn-settings');
  const settingsPanel = $('settings-panel');
  const settingsForm = $('settings-form');
  const inpApiKey = $('inp-apikey');
  const inpModel = $('inp-model');
  const inpBaseURL = $('inp-baseurl');
  const inpPreset = $('inp-preset');
  const btnSettingsRestart = $('btn-settings-restart');
  const btnSettingsClose = $('btn-settings-close');
  const settingsMsg = $('settings-msg');
  const trustListEl = $('trust-list');
  const btnTrustClear = $('btn-trust-clear');

  let running = false;
  let reasoningEl = null;
  let assistantEl = null;
  let reasoningBatcher = null;
  let assistantBatcher = null;
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
    // 每个元素一个新的 batch 器，flush 回调写到当前 reasoning 元素
    reasoningBatcher = createBatcher((text) => {
      reasoningEl.textContent += text;
      scrollBottom();
    });
  }

  // 流式 delta 先入 batch 器，按帧节流写 DOM（见 src/webview/streamBatcher）
  function appendReasoning(delta) {
    ensureReasoning();
    reasoningBatcher.append(delta);
  }

  function ensureAssistant() {
    if (assistantEl) return;
    assistantEl = el('div', 'message assistant');
    addMessage(assistantEl);
    assistantBatcher = createBatcher((text) => {
      assistantEl.textContent += text;
      scrollBottom();
    });
  }

  // 流式期间累积纯文本（廉价、安全）；仅在此处一次性渲染为已净化的 Markdown
  function appendAssistant(delta) {
    ensureAssistant();
    assistantBatcher.append(delta);
  }

  function finishAssistant() {
    // 先冲刷剩余缓冲，避免最后一段 token 丢失，再做一次性 Markdown 渲染
    if (assistantBatcher) assistantBatcher.flush();
    if (assistantEl) {
      const raw = assistantEl.textContent;
      assistantEl.innerHTML = renderMarkdown(raw);
    }
    if (reasoningBatcher) reasoningBatcher.flush();
    assistantEl = null;
    assistantBatcher = null;
    reasoningEl = null;
    reasoningBatcher = null;
  }

  // 清空当前时机（清空视图与历史回放共用）
  function clearMessages() {
    messagesEl.innerHTML = '';
    emptyEl.style.display = '';
    trajectoryEl.innerHTML = '';
    trajectoryBox.hidden = true;
    toolCards.clear();
    patchCards.clear();
    approvalCards.clear();
    for (const t of approvalTimers.values()) clearInterval(t);
    approvalTimers.clear();
    if (reasoningBatcher) { reasoningBatcher.reset(); reasoningBatcher = null; }
    if (assistantBatcher) { assistantBatcher.reset(); assistantBatcher = null; }
    reasoningEl = null;
    assistantEl = null;
    sessionEl.textContent = '';
    setRunning(false);
  }

  // 历史会话列表（A3）
  function renderHistory(list) {
    historyList.innerHTML = '';
    if (!Array.isArray(list) || list.length === 0) {
      historyList.appendChild(el('div', 'history-empty', '暂无历史会话'));
      return;
    }
    for (const s of list) {
      const item = el('div', 'history-item');
      item.appendChild(el('div', 'history-item-title', s.title || '(空会话)'));
      const meta = new Date(s.createdAt).toLocaleString() + ' · ' + s.messageCount + ' 条消息';
      item.appendChild(el('div', 'history-item-meta', meta));
      item.addEventListener('click', () => {
        vscode.postMessage({ kind: 'history.open', sessionId: s.sessionId });
      });
      historyList.appendChild(item);
    }
  }

  // 回放历史会话：清空视图后按 role 渲染完整消息（统一走 renderMarkdown 净化）
  function renderHistoryMessages(rec) {
    clearMessages();
    if (!rec || !Array.isArray(rec.messages)) return;
    for (const m of rec.messages) {
      if (m.role === 'user') {
        const node = el('div', 'message user');
        node.innerHTML = renderMarkdown(m.text);
        addMessage(node);
      } else if (m.role === 'assistant') {
        const node = el('div', 'message assistant');
        node.innerHTML = renderMarkdown(m.text);
        addMessage(node);
      } else {
        addSystem(m.text);
      }
    }
    sessionEl.textContent = 'history: ' + (rec.title || rec.sessionId);
    scrollBottom();
  }

  // 设置面板（A4）：打开时向扩展请求当前配置
  function openSettings() {
    historyPanel.hidden = true;
    settingsPanel.hidden = false;
    settingsMsg.textContent = '';
    btnSettingsRestart.hidden = true;
    btnSettingsRestart.disabled = false;
    vscode.postMessage({ kind: 'settings.get' });
    vscode.postMessage({ kind: 'trust.list' }); // B1：同步加载信任规则
  }

  function fillSettings(params) {
    const cfg = (params && params.config) || {};
    inpApiKey.placeholder = params && params.hasApiKey ? '已设置（留空不修改）' : '未设置';
    inpModel.value = cfg.model || '';
    inpBaseURL.value = cfg.baseURL || '';
    inpPreset.value = cfg.preset || '';
  }

  // ---- B1 信任记忆：设置面板中的免审批白名单管理
  function renderTrust(rules) {
    trustListEl.textContent = '';
    if (!rules || rules.length === 0) {
      trustListEl.appendChild(el('div', 'muted trust-empty', '暂无信任命令——审批卡点「接受并记住」来添加'));
      return;
    }
    for (const r of rules) {
      const row = el('div', 'trust-row');
      const kind = el('span', 'badge' + (r.kind === 'exact' ? ' warn' : ''), r.kind === 'exact' ? '精确' : '前缀');
      const pat = el('code', 'trust-pattern', r.pattern);
      const time = el('span', 'muted trust-time', new Date(r.createdAt).toLocaleString());
      row.appendChild(kind);
      row.appendChild(pat);
      row.appendChild(time);
      trustListEl.appendChild(row);
    }
  }

  btnTrustClear.addEventListener('click', () => {
    vscode.postMessage({ kind: 'trust.clear' });
    renderTrust([]); // 乐观清空；扩展回传 trust.loaded 再同步
  });

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
    // B1 信任记忆：批准并记住 -> 同规则命令后续免审批（高危命令由 daemon 自动降级为精确匹配）
    const btnTrust = el('button', 'ok-btn trust-btn', '接受并记住');
    function markExpired() {
      btnAccept.disabled = btnTrust.disabled = btnReject.disabled = true;
      const badge = card.querySelector('.badge');
      if (badge) {
        badge.className = 'badge err';
        badge.textContent = 'expired';
      }
      if (timerInfo) timerInfo.countdown.textContent = '⏱ 已过期（按拒绝处理）';
    }
    btnReject.addEventListener('click', () => {
      vscode.postMessage({ kind: 'approval.respond', approvalId: p.approvalId, approved: false });
      btnAccept.disabled = btnTrust.disabled = btnReject.disabled = true;
      stopTimer();
    });
    btnAccept.addEventListener('click', () => {
      vscode.postMessage({ kind: 'approval.respond', approvalId: p.approvalId, approved: true });
      btnAccept.disabled = btnTrust.disabled = btnReject.disabled = true;
      stopTimer();
    });
    btnTrust.addEventListener('click', () => {
      vscode.postMessage({ kind: 'approval.respond', approvalId: p.approvalId, approved: true, trust: true });
      btnAccept.disabled = btnTrust.disabled = btnReject.disabled = true;
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
    actions.appendChild(btnTrust);
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
    // P2 编辑后应用：第一次点击打开 Diff（可编辑）并切换文案，第二次点击回传编辑后内容
    const btnApplyEdited = el('button', 'ok-btn trust-btn', '编辑并应用');
    const disableAll = () => {
      btnAccept.disabled = btnReject.disabled = btnDiff.disabled = btnApplyEdited.disabled = true;
    };
    btnDiff.addEventListener('click', () => {
      vscode.postMessage({ kind: 'patch.openDiff', patchId: p.patchId });
    });
    btnReject.addEventListener('click', () => {
      vscode.postMessage({ kind: 'patch.reject', patchId: p.patchId });
      disableAll();
    });
    btnAccept.addEventListener('click', () => {
      vscode.postMessage({ kind: 'patch.accept', patchId: p.patchId });
      disableAll();
    });
    btnApplyEdited.addEventListener('click', () => {
      if (btnApplyEdited.dataset.editing !== '1') {
        btnApplyEdited.dataset.editing = '1';
        btnApplyEdited.textContent = '确认应用编辑';
        vscode.postMessage({ kind: 'patch.openDiff', patchId: p.patchId });
      } else {
        vscode.postMessage({ kind: 'patch.applyEdited', patchId: p.patchId });
        disableAll();
      }
    });
    actions.appendChild(btnDiff);
    actions.appendChild(btnReject);
    actions.appendChild(btnAccept);
    actions.appendChild(btnApplyEdited);
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
      case 'history.loaded':
        renderHistoryMessages(params);
        break;
      case 'settings.loaded':
        fillSettings(params);
        break;
      case 'settings.applied':
        settingsMsg.textContent = '已保存，重启 daemon 后生效。';
        btnSettingsRestart.hidden = false;
        inpApiKey.value = '';
        break;
      case 'trust.loaded':
        renderTrust(params && params.rules);
        break;
      case 'daemon.restarted':
        btnSettingsRestart.disabled = false;
        settingsMsg.textContent = 'daemon 已重启。';
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
        renderHistory(msg.state && msg.state.history);
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
  btnClear.addEventListener('click', clearMessages);
  btnHistory.addEventListener('click', () => {
    settingsPanel.hidden = true;
    historyPanel.hidden = !historyPanel.hidden;
  });
  btnSettings.addEventListener('click', () => {
    if (settingsPanel.hidden) openSettings();
    else settingsPanel.hidden = true;
  });
  btnSettingsClose.addEventListener('click', () => {
    settingsPanel.hidden = true;
  });
  btnSettingsRestart.addEventListener('click', () => {
    btnSettingsRestart.disabled = true;
    settingsMsg.textContent = '正在重启 daemon…';
    vscode.postMessage({ kind: 'daemon.restart' });
  });
  settingsForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const apiKey = inpApiKey.value.trim();
    const model = inpModel.value.trim();
    const baseURL = inpBaseURL.value.trim();
    const preset = inpPreset.value.trim();
    // apiKey 留空表示不修改（不上报空串，避免误删已存凭据）
    vscode.postMessage({
      kind: 'settings.apply',
      settings: {
        ...(apiKey ? { apiKey } : {}),
        model,
        baseURL,
        preset,
      },
    });
    settingsMsg.textContent = '保存中…';
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
