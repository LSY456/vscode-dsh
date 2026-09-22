/* dsh Agent Webview UI（vanilla JS，无框架依赖）。
 * 经 esbuild 打包：本文件为 bundle 入口，import 的 Markdown 渲染模块会内联其中。
 *
 * UI 约定（与 media/webview.css 配套）：
 *  - 回答是主角：assistant 文本不做卡片包装，过程（推理 / 工具）折叠进「过程」时间线；
 *  - 挂起项（审批 / 补丁）除了留在消息流里，还投影到输入框上方的待办条，永远不会被滚出视野；
 *  - 滚动锁定：用户往上翻看历史时不再被流式输出硬拽到底部，改为浮出「有新内容」按钮；
 *  - 挂起项 60s 过期，卡片与待办条都显示倒计时。
 */
import { renderMarkdown } from '../src/webview/render.js';
import { createBatcher } from '../src/webview/streamBatcher.js';

(function () {
  'use strict';

  // eslint-disable-next-line no-undef
  const vscode = acquireVsCodeApi();

  const $ = (id) => document.getElementById(id);
  const mainEl = $('main');
  const messagesEl = $('messages');
  const emptyEl = $('empty');
  const statusEl = $('status');
  const connDot = $('conn-dot');
  const agentModeEl = $('agent-mode');
  const sessionEl = $('session-id');
  const inputEl = $('input');
  const btnSend = $('btn-send');
  const btnCancel = $('btn-cancel');
  const btnNew = $('btn-new');
  const btnJump = $('btn-jump');
  const composerHint = $('composer-hint');
  const trajectoryBox = $('trajectory-box');
  const trajectoryEl = $('trajectory');
  const trajCountEl = $('traj-count');
  const btnHistory = $('btn-history');
  const historyPanel = $('history-panel');
  const historyList = $('history-list');
  const btnHistoryClose = $('btn-history-close');
  const btnSettings = $('btn-settings');
  const settingsPanel = $('settings-panel');
  const settingsForm = $('settings-form');
  const inpApiKey = $('inp-apikey');
  const inpModel = $('inp-model');
  const inpBaseURL = $('inp-baseurl');
  const inpProvider = $('inp-provider');
  const inpPreset = $('inp-preset');
  const btnSettingsRestart = $('btn-settings-restart');
  const btnSettingsClose = $('btn-settings-close');
  const settingsMsg = $('settings-msg');
  const trustListEl = $('trust-list');
  const btnTrustClear = $('btn-trust-clear');
  const pendingBar = $('pending-bar');
  const pendingLabel = $('pending-label');
  const pendingActions = $('pending-actions');

  let running = false;
  let pinned = true;
  let trajCount = 0;

  // 当前回合的可变容器（新回合重置）
  let answerEl = null;
  let answerBody = null;
  let answerBatcher = null;
  let reasoningEl = null;
  let reasoningBody = null;
  let reasoningLabel = null;
  let reasoningStartedAt = 0;
  let reasoningTimer = null;
  let reasoningBatcher = null;
  let activityEl = null;
  let activityList = null;
  let activityMeta = null;
  let activityStartedAt = 0;
  let activitySteps = 0;

  const toolRows = new Map(); // tool -> { row, body, dur, startedAt }
  const approvals = new Map(); // approvalId -> entry
  const patches = new Map(); // patchId -> entry
  const approvalTimers = new Map(); // approvalId -> interval id
  const patchTimers = new Map(); // patchId -> interval id
  let pendingTicker = null;
  let pendingCountdownEl = null;

  // -------------------------------------------------------------------------
  // DOM 工具
  // -------------------------------------------------------------------------

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function fmtDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '—';
    if (ms < 1000) return Math.round(ms) + 'ms';
    return (ms / 1000).toFixed(1) + 's';
  }

  // 只有用户本来就在底部时才自动跟随；否则浮出「有新内容」按钮（不打断阅读）
  function nearBottom() {
    return mainEl.scrollHeight - mainEl.scrollTop - mainEl.clientHeight <= 32;
  }

  function scrollBottom(force) {
    if (force || pinned) {
      mainEl.scrollTop = mainEl.scrollHeight;
      pinned = true;
      btnJump.hidden = true;
    } else {
      btnJump.hidden = false;
    }
  }

  mainEl.addEventListener('scroll', () => {
    pinned = nearBottom();
    if (pinned) btnJump.hidden = true;
  });
  btnJump.addEventListener('click', () => scrollBottom(true));

  function addMessage(node) {
    emptyEl.style.display = 'none';
    messagesEl.appendChild(node);
    scrollBottom();
    return node;
  }

  const STATUS_LABEL = {
    connected: '已连接',
    connecting: '连接中…',
    starting: '启动中…',
    stopped: '未启动',
    disabled: '仅 UI 模式',
    error: '错误',
  };

  function setStatus(status, detail) {
    statusEl.className = 'status ' + (status || '');
    connDot.className = 'dot ' + (status || '');
    const label = STATUS_LABEL[status] || status || '未知';
    statusEl.textContent = detail ? label + ' — ' + detail : label;
    statusEl.title = detail || '';
  }

  function setAgentInfo(state) {
    const agent = state && state.agent;
    const model = state && state.model;
    if (!agent && !model) {
      agentModeEl.hidden = true;
      return;
    }
    agentModeEl.hidden = false;
    agentModeEl.textContent = [agent, model].filter(Boolean).join(' · ');
    agentModeEl.title =
      agent === 'mock'
        ? '当前使用 mock Agent（未配置 API Key，仅演示协议流程）'
        : '当前使用真实模型 Agent';
  }

  function setSession(id) {
    if (!id) {
      sessionEl.hidden = true;
      sessionEl.textContent = '';
      sessionEl.title = '';
      return;
    }
    sessionEl.hidden = false;
    sessionEl.textContent = 'session ' + String(id).slice(0, 12);
    sessionEl.title = id;
  }

  function setRunning(r) {
    running = r;
    btnSend.disabled = r;
    btnCancel.hidden = !r;
    btnSend.textContent = r ? '处理中…' : '发送';
    composerHint.textContent = r ? 'Esc 停止当前回答' : 'Enter 发送 · Shift+Enter 换行';
  }

  function autosizeInput() {
    inputEl.style.height = 'auto';
    const h = Math.min(inputEl.scrollHeight, 180);
    inputEl.style.height = h + 'px';
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* webview 可能禁用剪贴板 API，回退到 execCommand */
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('aria-hidden', 'true');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }

  function addCopyAction(container, raw) {
    if (!container || !container.querySelector) return;
    if (container.querySelector('.msg-actions')) return;
    const row = el('div', 'msg-actions');
    const btn = el('button', 'icon-btn', '复制');
    btn.type = 'button';
    btn.title = '复制回答原文';
    btn.addEventListener('click', async () => {
      const ok = await copyText(raw);
      btn.textContent = ok ? '已复制' : '复制失败';
      setTimeout(() => {
        btn.textContent = '复制';
      }, 1500);
    });
    row.appendChild(btn);
    container.appendChild(row);
  }

  // -------------------------------------------------------------------------
  // 消息渲染
  // -------------------------------------------------------------------------

  function addSystem(text) {
    addMessage(el('div', 'message system', text));
  }

  function addError(text) {
    addMessage(el('div', 'message error', '⚠ ' + text));
  }

  // 用户回合：气泡 + 「Agent 看到了什么」上下文 chip（上下文保真是这个插件的核心卖点）
  function addUser(text, attachments) {
    const turn = el('div', 'turn user');
    const bubble = el('div', 'message user');
    bubble.innerHTML = renderMarkdown(text);
    turn.appendChild(bubble);
    const chips = Array.isArray(attachments) ? attachments : [];
    if (chips.length) {
      const row = el('div', 'chips');
      for (const c of chips) {
        const label = typeof c === 'string' ? c : c && c.label;
        if (label) row.appendChild(el('span', 'chip', String(label)));
      }
      if (row.childNodes.length) turn.appendChild(row);
    }
    addMessage(turn);
    return turn;
  }

  function addAssistantHtml(md) {
    const turn = el('div', 'turn assistant');
    const body = el('div', 'message assistant md');
    body.innerHTML = renderMarkdown(md);
    turn.appendChild(body);
    addMessage(turn);
    return turn;
  }

  function ensureAnswer() {
    if (answerEl) return;
    answerEl = el('div', 'turn assistant');
    answerBody = el('div', 'message assistant md streaming', '');
    answerEl.appendChild(answerBody);
    addMessage(answerEl);
    answerBatcher = createBatcher((text) => {
      answerBody.textContent += text;
      scrollBottom();
    });
  }

  function appendAssistant(delta) {
    ensureAnswer();
    answerBatcher.append(delta);
  }

  // 流式期间累积纯文本（廉价、安全）；结束时一次性渲染为已净化的 Markdown
  function finishAssistant() {
    if (answerBatcher) answerBatcher.flush();
    if (answerBody) {
      const raw = answerBody.textContent;
      answerBody.classList.remove('streaming');
      answerBody.innerHTML = renderMarkdown(raw);
      addCopyAction(answerEl, raw);
    }
    finishReasoning();
    answerEl = null;
    answerBody = null;
    answerBatcher = null;
  }

  // ---- 推理流：默认折叠，只用一个计时标签提示「正在思考」，不挤占回答
  function ensureReasoning() {
    if (reasoningEl) return;
    const details = el('details', 'reasoning');
    const summary = el('summary', '');
    reasoningLabel = el('span', 'reasoning-label', '思考中…');
    summary.appendChild(reasoningLabel);
    reasoningBody = el('pre', 'reasoning-body', '');
    details.appendChild(summary);
    details.appendChild(reasoningBody);
    reasoningStartedAt = Date.now();
    reasoningTimer = setInterval(() => {
      if (reasoningLabel) reasoningLabel.textContent = '思考中… ' + fmtDuration(Date.now() - reasoningStartedAt);
    }, 1000);
    reasoningBatcher = createBatcher((text) => {
      reasoningBody.textContent += text;
      if (details.open) scrollBottom();
    });
    addMessage(details);
    reasoningEl = details;
  }

  function appendReasoning(delta) {
    ensureReasoning();
    reasoningBatcher.append(delta);
  }

  function finishReasoning() {
    if (reasoningBatcher) reasoningBatcher.flush();
    if (reasoningTimer) {
      clearInterval(reasoningTimer);
      reasoningTimer = null;
    }
    if (reasoningLabel) {
      const text = reasoningBody ? reasoningBody.textContent : '';
      reasoningLabel.textContent =
        '已思考 ' + fmtDuration(Math.max(1, Date.now() - reasoningStartedAt)) + (text ? '（点击展开）' : '');
    }
    reasoningEl = null;
    reasoningBody = null;
    reasoningLabel = null;
    reasoningBatcher = null;
  }

  // ---- 过程：把工具调用聚合成一条时间线，步骤可展开看输入/输出
  function ensureActivity() {
    if (activityEl) return;
    activityEl = el('section', 'activity');
    const head = el('div', 'activity-head');
    head.appendChild(el('span', 'chev', '▾'));
    head.appendChild(el('b', '', '过程'));
    activityMeta = el('span', 'activity-meta', '执行中…');
    head.appendChild(activityMeta);
    head.addEventListener('click', () => activityEl.classList.toggle('collapsed'));
    activityList = el('div', 'activity-list');
    activityEl.appendChild(head);
    activityEl.appendChild(activityList);
    activityStartedAt = Date.now();
    activitySteps = 0;
    addMessage(activityEl);
  }

  function updateActivityMeta() {
    if (!activityMeta) return;
    activityMeta.textContent = activitySteps + ' 步 · ' + fmtDuration(Date.now() - activityStartedAt);
  }

  function describeToolInput(input) {
    const i = input || {};
    const direct = ['path', 'command', 'pattern', 'query', 'file'];
    for (const k of direct) {
      if (typeof i[k] === 'string' && i[k]) return i[k];
    }
    const first = Object.values(i).find((v) => typeof v === 'string' && v);
    return first || '';
  }

  function addToolRow(tool, input) {
    ensureActivity();
    if (toolRows.has(tool)) return;
    const row = el('div', 'tool-row running');
    const line = el('div', 'tool-line');
    line.appendChild(el('code', 'tool-name', tool));
    line.appendChild(el('span', 'tool-detail', describeToolInput(input)));
    const dur = el('span', 'tool-dur', '执行中');
    line.appendChild(dur);
    const body = el('div', 'tool-body');
    body.appendChild(el('pre', 'code-block', JSON.stringify(input ?? {}, null, 2)));
    row.appendChild(line);
    row.appendChild(body);
    row.addEventListener('click', () => row.classList.toggle('open'));
    activityList.appendChild(row);
    activitySteps += 1;
    updateActivityMeta();
    toolRows.set(tool, { row, body, dur, startedAt: Date.now() });
    scrollBottom();
  }

  function updateToolRow(tool, executed) {
    const entry = toolRows.get(tool);
    if (!entry) return;
    const ms =
      typeof executed.durationMs === 'number' ? executed.durationMs : Date.now() - entry.startedAt;
    entry.row.classList.remove('running');
    entry.row.classList.add(executed.ok ? 'ok' : 'failed');
    entry.dur.textContent = fmtDuration(ms);
    entry.body.appendChild(el('pre', 'code-block', executed.output ?? '(无输出)'));
    if (!executed.ok) entry.row.classList.add('open');
    toolRows.delete(tool);
    updateActivityMeta();
    scrollBottom();
  }

  function resetTurn() {
    finishReasoning();
    activityEl = null;
    activityList = null;
    activityMeta = null;
    activitySteps = 0;
    toolRows.clear();
  }

  // -------------------------------------------------------------------------
  // 审批卡（Human-in-the-Loop）
  // -------------------------------------------------------------------------

  function stopApprovalTimer(id) {
    const t = approvalTimers.get(id);
    if (t) {
      clearInterval(t);
      approvalTimers.delete(id);
    }
  }

  function markApprovalDecided(entry, outcome) {
    entry.decided = true;
    entry.card.classList.add('decided');
    for (const b of entry.buttons) b.disabled = true;
    if (entry.countdown) entry.countdown.textContent = '';
    if (entry.badge) {
      if (outcome === 'rejected') {
        entry.badge.className = 'badge err';
        entry.badge.textContent = '已拒绝';
      } else if (outcome === 'expired') {
        entry.badge.className = 'badge err';
        entry.badge.textContent = '已过期';
      } else {
        entry.badge.className = 'badge ok';
        entry.badge.textContent = outcome === 'trusted' ? '已接受并记住' : '已接受';
      }
    }
  }

  function decideApproval(approvalId, approved, trust) {
    const entry = approvals.get(approvalId);
    if (entry && entry.decided) return;
    if (entry) markApprovalDecided(entry, approved ? (trust ? 'trusted' : 'accepted') : 'rejected');
    vscode.postMessage({
      kind: 'approval.respond',
      approvalId,
      approved,
      ...(trust ? { trust: true } : {}),
    });
    stopApprovalTimer(approvalId);
    updatePendingBar();
  }

  function addApprovalCard(p) {
    const card = el('div', 'card approval risk-' + (p.risk || 'medium'));
    const title = el('div', 'card-title');
    title.appendChild(el('b', '', '⚠ 工具审批'));
    const badge = el('span', 'badge warn', p.risk || 'medium');
    title.appendChild(badge);
    title.appendChild(el('code', 'card-sub', p.tool));
    card.appendChild(title);
    if (p.reason) card.appendChild(el('div', 'card-reason', p.reason));
    card.appendChild(el('pre', 'code-block', JSON.stringify(p.input ?? {}, null, 2)));

    const countdown = el('div', 'countdown', '');
    const actions = el('div', 'card-actions');
    const btnReject = el('button', 'danger', '拒绝');
    const btnAccept = el('button', 'ok-btn', '接受');
    const btnTrust = el('button', 'ok-btn', '接受并记住');
    btnReject.type = btnAccept.type = btnTrust.type = 'button';
    btnReject.addEventListener('click', () => decideApproval(p.approvalId, false, false));
    btnAccept.addEventListener('click', () => decideApproval(p.approvalId, true, false));
    btnTrust.addEventListener('click', () => decideApproval(p.approvalId, true, true));
    actions.append(btnReject, btnAccept, btnTrust);

    if (p.expiresAt) card.appendChild(countdown);
    card.appendChild(actions);
    addMessage(card);

    const entry = {
      data: p,
      card,
      badge,
      countdown: p.expiresAt ? countdown : null,
      buttons: [btnReject, btnAccept, btnTrust],
      decided: false,
    };
    approvals.set(p.approvalId, entry);

    if (p.expiresAt) {
      const tick = () => {
        const remain = Math.max(0, Math.ceil((p.expiresAt - Date.now()) / 1000));
        if (remain <= 0) {
          countdown.textContent = '⏱ 已过期（按拒绝处理）';
          expireApproval(p.approvalId);
          return;
        }
        countdown.textContent = '⏱ 剩余 ' + remain + 's 未响应将按拒绝处理';
      };
      approvalTimers.set(p.approvalId, setInterval(tick, 1000));
      tick();
    }
    updatePendingBar();
  }

  function expireApproval(approvalId) {
    stopApprovalTimer(approvalId);
    const entry = approvals.get(approvalId);
    if (entry && !entry.decided) markApprovalDecided(entry, 'expired');
    updatePendingBar();
  }

  function onApprovalResponded(approvalId) {
    // daemon 已受理：卡片作为历史保留，只置为不可再操作
    stopApprovalTimer(approvalId);
    const entry = approvals.get(approvalId);
    if (entry && !entry.decided) markApprovalDecided(entry, 'accepted');
    updatePendingBar();
  }

  // -------------------------------------------------------------------------
  // 文件补丁卡（Native Diff 预览入口）
  // -------------------------------------------------------------------------

  function decidePatch(patchId, action) {
    const entry = patches.get(patchId);
    if (entry && entry.responded) return;
    stopPatchTimer(patchId);
    // responded：用户已表态（待办条立即释放）；decided：daemon 已回执（卡片标记最终结果）。
    // 两者分开，才能做到「点了就有反馈」而不谎报结果。
    if (entry) {
      entry.responded = true;
      for (const b of entry.buttons) b.disabled = true;
      if (action === 'reject') {
        entry.decided = true;
        entry.card.classList.add('decided');
      }
      if (action === 'reject' && entry.badge) {
        entry.badge.className = 'badge err';
        entry.badge.textContent = '已拒绝';
      }
    }
    const kind =
      action === 'accept' ? 'patch.accept' : action === 'reject' ? 'patch.reject' : 'patch.applyEdited';
    vscode.postMessage({ kind, patchId });
    updatePendingBar();
  }

  function addPatchCard(p) {
    const card = el('div', 'card patch');
    const title = el('div', 'card-title');
    title.appendChild(el('b', '', '📝 文件补丁'));
    const badge = el('span', 'badge warn', '待审查');
    title.appendChild(badge);
    card.appendChild(title);
    card.appendChild(el('div', 'card-sub', p.path || ''));
    if (p.description) card.appendChild(el('div', 'card-reason', p.description));

    const actions = el('div', 'card-actions');
    const btnDiff = el('button', '', '打开 Diff');
    const btnReject = el('button', 'danger', '拒绝');
    const btnAccept = el('button', 'ok-btn', '应用');
    const btnEdit = el('button', 'ok-btn', '编辑后应用');
    btnDiff.type = btnReject.type = btnAccept.type = btnEdit.type = 'button';
    btnDiff.addEventListener('click', () => vscode.postMessage({ kind: 'patch.openDiff', patchId: p.patchId }));
    btnReject.addEventListener('click', () => decidePatch(p.patchId, 'reject'));
    btnAccept.addEventListener('click', () => decidePatch(p.patchId, 'accept'));
    // P2 编辑后应用：第一次点击打开 Diff（可编辑）并切换文案，第二次点击回传编辑后内容
    btnEdit.addEventListener('click', () => {
      if (btnEdit.dataset.editing === '1') {
        decidePatch(p.patchId, 'applyEdited');
        return;
      }
      btnEdit.dataset.editing = '1';
      btnEdit.textContent = '确认应用编辑';
      vscode.postMessage({ kind: 'patch.openDiff', patchId: p.patchId });
    });
    actions.append(btnDiff, btnReject, btnAccept, btnEdit);
    // 补丁同样会过期（daemon 按 approvalTtlMs 盖戳），过期即按拒绝处理
    let countdown = null;
    if (p.expiresAt) {
      countdown = el('div', 'countdown', '');
      card.appendChild(countdown);
      const tick = () => {
        const remain = Math.max(0, Math.ceil((p.expiresAt - Date.now()) / 1000));
        if (remain <= 0) {
          expirePatch(p.patchId);
          return;
        }
        countdown.textContent = '⏱ 剩余 ' + remain + 's 未响应将按拒绝处理';
      };
      patchTimers.set(p.patchId, setInterval(tick, 1000));
      tick();
    }
    card.appendChild(actions);
    addMessage(card);

    patches.set(p.patchId, {
      data: p,
      card,
      badge,
      countdown,
      buttons: [btnDiff, btnReject, btnAccept, btnEdit],
      responded: false,
      decided: false,
    });
    updatePendingBar();
  }

  function stopPatchTimer(patchId) {
    const t = patchTimers.get(patchId);
    if (t) {
      clearInterval(t);
      patchTimers.delete(patchId);
    }
  }

  /** 补丁过期：按拒绝处理（daemon 也会回 file.patch.result，届时再落到最终状态）。 */
  function expirePatch(patchId) {
    stopPatchTimer(patchId);
    const entry = patches.get(patchId);
    if (entry && !entry.responded) {
      entry.responded = true;
      entry.decided = true;
      entry.card.classList.add('decided');
      for (const b of entry.buttons) b.disabled = true;
      if (entry.badge) {
        entry.badge.className = 'badge err';
        entry.badge.textContent = '已过期';
      }
      if (entry.countdown) entry.countdown.textContent = '⏱ 已过期（按拒绝处理）';
    }
    updatePendingBar();
  }

  function updatePatchCard(result) {
    stopPatchTimer(result.patchId);
    const entry = patches.get(result.patchId);
    if (entry) {
      entry.decided = true;
      entry.card.classList.add('decided');
      for (const b of entry.buttons) b.disabled = true;
      if (entry.badge) {
        if (result.applied) {
          entry.badge.className = 'badge ok';
          entry.badge.textContent = '已应用';
        } else if (result.accepted && result.error) {
          entry.badge.className = 'badge err';
          entry.badge.textContent = '应用失败';
        } else {
          entry.badge.className = 'badge err';
          entry.badge.textContent = '已拒绝';
        }
      }
      if (result.error) entry.card.appendChild(el('pre', 'code-block', result.error));
      patches.delete(result.patchId);
    }
    updatePendingBar();
    scrollBottom();
  }

  // -------------------------------------------------------------------------
  // 待办条：挂起项投影到输入框上方，滚到哪儿都不会漏掉（60s 过期倒计时同步显示）
  // -------------------------------------------------------------------------

  function openApprovals() {
    return [...approvals.values()].filter((e) => !e.decided);
  }

  function openPatches() {
    return [...patches.values()].filter((e) => !e.responded);
  }

  function stopPendingTicker() {
    if (pendingTicker) {
      clearInterval(pendingTicker);
      pendingTicker = null;
    }
  }

  function tickPending() {
    if (!pendingCountdownEl) return;
    const expiresAt = earliestExpiry();
    if (!expiresAt) {
      pendingCountdownEl.textContent = '';
      return;
    }
    const remain = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
    pendingCountdownEl.textContent = remain > 0 ? '⏱ ' + remain + 's' : '⏱ 已过期';
  }

  /** 待办条倒计时取所有挂起项里最早到期的一个（审批与补丁同权）。 */
  function earliestExpiry() {
    const values = [...openApprovals(), ...openPatches()]
      .map((e) => e.data.expiresAt)
      .filter((v) => typeof v === 'number');
    return values.length ? Math.min(...values) : undefined;
  }

  function ensurePendingTicker() {
    if (pendingTicker) return;
    pendingTicker = setInterval(tickPending, 1000);
  }

  function updatePendingBar() {
    const openA = openApprovals();
    const openP = openPatches();
    const total = openA.length + openP.length;
    pendingLabel.textContent = '';
    pendingActions.textContent = '';
    pendingCountdownEl = null;

    if (total === 0) {
      pendingBar.hidden = true;
      stopPendingTicker();
      return;
    }

    pendingBar.hidden = false;
    const more = total > 1 ? '另有 ' + (total - 1) + ' 项待处理' : '';

    const mkButton = (label, cls, onClick) => {
      const b = el('button', cls, label);
      b.type = 'button';
      b.addEventListener('click', onClick);
      return b;
    };

    if (openA.length) {
      const entry = openA[0];
      const d = entry.data;
      pendingLabel.appendChild(el('b', '', '等待你批准工具：' + d.tool));
      if (d.reason) pendingLabel.appendChild(el('small', '', d.reason));
      if (more) pendingLabel.appendChild(el('small', '', more));
      const id = d.approvalId;
      pendingActions.append(
        mkButton('拒绝', 'danger', () => decideApproval(id, false, false)),
        mkButton('接受', 'ok-btn', () => decideApproval(id, true, false)),
        mkButton('接受并记住', 'ok-btn', () => decideApproval(id, true, true))
      );
    } else {
      const entry = openP[0];
      const d = entry.data;
      pendingLabel.appendChild(el('b', '', '等待你审查文件补丁'));
      if (d.path) pendingLabel.appendChild(el('small', '', d.path));
      if (more) pendingLabel.appendChild(el('small', '', more));
      const id = d.patchId;
      pendingActions.append(
        mkButton('打开 Diff', '', () => vscode.postMessage({ kind: 'patch.openDiff', patchId: id })),
        mkButton('拒绝', 'danger', () => decidePatch(id, 'reject')),
        mkButton('应用', 'primary', () => decidePatch(id, 'accept'))
      );
    }

    if (earliestExpiry() !== undefined) {
      pendingCountdownEl = el('span', 'badge warn', '');
      pendingLabel.appendChild(pendingCountdownEl);
    }
    ensurePendingTicker();
    tickPending();
  }

  // -------------------------------------------------------------------------
  // 迹线（会话级审计信息，独立于消息流）
  // -------------------------------------------------------------------------

  function addTrajectory(t) {
    trajectoryBox.hidden = false;
    trajCount += 1;
    trajCountEl.textContent = trajCount + ' 步';
    const line = el('div', 'traj-line');
    line.appendChild(el('span', 'traj-step', '#' + t.step));
    line.appendChild(el('span', 'traj-kind', t.kind));
    line.appendChild(el('span', '', t.detail));
    trajectoryEl.appendChild(line);
  }

  // -------------------------------------------------------------------------
  // 面板与视图重置
  // -------------------------------------------------------------------------

  /**
   * 会话级重置：新建会话 / 切回旧会话 / 断线重放前调用。
   * 除了清空视图，还要清掉上一会话的挂起卡片（它们的 approvalId 在新会话里已失效）。
   */
  function resetForSession(sessionId, reason) {
    clearMessages();
    setSession(sessionId);
    const short = sessionId ? String(sessionId).slice(0, 12) : '';
    if (reason === 'new') addSystem(short ? '已新建会话：' + short : '已新建会话');
    else if (reason === 'switch') addSystem('已切换到会话 ' + short + '，可继续对话');
    else if (reason === 'replay') addSystem('连接已恢复，正在重放会话内容…');
  }

  /** surface 重建后恢复挂起项（审批 / 补丁卡与待办条） */
  function restorePending(pending) {
    if (!pending) return;
    for (const p of pending.approvals || []) addApprovalCard(p);
    for (const p of pending.patches || []) addPatchCard(p);
  }

  function clearMessages() {
    messagesEl.textContent = '';
    emptyEl.style.display = '';
    trajectoryEl.textContent = '';
    trajectoryBox.hidden = true;
    trajectoryBox.open = false;
    trajCount = 0;
    trajCountEl.textContent = '';
    toolRows.clear();
    approvals.clear();
    patches.clear();
    for (const t of approvalTimers.values()) clearInterval(t);
    approvalTimers.clear();
    for (const t of patchTimers.values()) clearInterval(t);
    patchTimers.clear();
    stopPendingTicker();
    pendingCountdownEl = null;
    updatePendingBar();
    if (reasoningBatcher) reasoningBatcher.reset();
    if (answerBatcher) answerBatcher.reset();
    if (reasoningTimer) clearInterval(reasoningTimer);
    reasoningTimer = null;
    reasoningEl = null;
    reasoningBody = null;
    reasoningLabel = null;
    reasoningBatcher = null;
    answerEl = null;
    answerBody = null;
    answerBatcher = null;
    activityEl = null;
    activityList = null;
    activityMeta = null;
    setSession('');
    btnJump.hidden = true;
    pinned = true;
    setRunning(false);
  }

  // -------------------------------------------------------------------------
  // 历史会话（A3）
  // -------------------------------------------------------------------------

  function renderHistory(list) {
    historyList.textContent = '';
    if (!Array.isArray(list) || list.length === 0) {
      historyList.appendChild(el('div', 'history-empty', '暂无历史会话'));
      return;
    }
    for (const s of list) {
      const item = el('div', 'history-item');
      item.tabIndex = 0;
      item.appendChild(el('div', 'history-item-title', s.title || '(空会话)'));
      const meta = new Date(s.createdAt).toLocaleString() + ' · ' + s.messageCount + ' 条消息';
      item.appendChild(el('div', 'history-item-meta', meta));
      const open = () => vscode.postMessage({ kind: 'history.open', sessionId: s.sessionId });
      item.addEventListener('click', () => {
        closeSheets();
        open();
      });
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      });
      historyList.appendChild(item);
    }
  }

  // 回放历史会话：清空视图后按 role 渲染完整消息（统一走 renderMarkdown 净化）
  function renderHistoryMessages(rec) {
    clearMessages();
    if (!rec || !Array.isArray(rec.messages)) return;
    for (const m of rec.messages) {
      if (m.role === 'user') addUser(m.text);
      else if (m.role === 'assistant') addAssistantHtml(m.text);
      else addSystem(m.text);
    }
    scrollBottom(true);
  }

  // -------------------------------------------------------------------------
  // 设置面板（A4）
  // -------------------------------------------------------------------------

  function openSheet(which) {
    const history = which === 'history';
    historyPanel.hidden = !history;
    settingsPanel.hidden = history;
    if (history) return;
    settingsMsg.textContent = '';
    btnSettingsRestart.hidden = true;
    btnSettingsRestart.disabled = false;
    vscode.postMessage({ kind: 'settings.get' });
    vscode.postMessage({ kind: 'trust.list' }); // B1：同步加载信任规则
  }

  function closeSheets() {
    historyPanel.hidden = true;
    settingsPanel.hidden = true;
  }

  function fillSettings(params) {
    const cfg = (params && params.config) || {};
    inpApiKey.placeholder = params && params.hasApiKey ? '已设置（留空不修改）' : '未设置';
    inpModel.value = cfg.model || '';
    inpBaseURL.value = cfg.baseURL || '';
    inpProvider.value = cfg.provider || 'auto';
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

  // -------------------------------------------------------------------------
  // 事件分发（extension -> webview）
  // -------------------------------------------------------------------------

  function handleEvent(method, params) {
    switch (method) {
      case 'user.message':
        resetTurn();
        addUser(params.text, params.attachments);
        break;
      case 'session.started':
        setRunning(true);
        setSession(params.sessionId);
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
        addToolRow(params.tool, params.input);
        break;
      case 'tool.executed':
        updateToolRow(params.tool, params);
        break;
      case 'approval.request':
        addApprovalCard(params);
        break;
      case 'approval.expired':
        expireApproval(params.approvalId);
        break;
      case 'approval.responded':
        onApprovalResponded(params.approvalId);
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
      case 'notice':
        addSystem(params.text);
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
        setSession(msg.state && msg.state.sessionId);
        setAgentInfo(msg.state);
        if (msg.state && msg.state.connected) setStatus('connected', '');
        renderHistory(msg.state && msg.state.history);
        restorePending(msg.state && msg.state.pending);
        break;
      case 'session.reset':
        resetForSession(msg.sessionId, msg.reason);
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
    inputEl.value = '';
    autosizeInput();
    setRunning(true);
    // 不在本地回显：扩展侧会带上下文 chip 回发 user.message，避免出现两条重复消息
    vscode.postMessage({ kind: 'send', prompt: text });
  }

  function cancel() {
    if (!running) return;
    composerHint.textContent = '正在停止…';
    vscode.postMessage({ kind: 'cancel' });
  }

  btnSend.addEventListener('click', send);
  btnCancel.addEventListener('click', cancel);
  btnNew.addEventListener('click', () => {
    vscode.postMessage({ kind: 'session.new' });
  });
  btnHistory.addEventListener('click', () => {
    if (historyPanel.hidden) openSheet('history');
    else closeSheets();
  });
  btnHistoryClose.addEventListener('click', closeSheets);
  btnSettings.addEventListener('click', () => {
    if (settingsPanel.hidden) openSheet('settings');
    else closeSheets();
  });
  btnSettingsClose.addEventListener('click', closeSheets);
  for (const backdrop of document.querySelectorAll('.sheet-backdrop')) {
    backdrop.addEventListener('click', () => {
      const sheet = backdrop.parentElement;
      if (sheet) sheet.hidden = true;
    });
  }
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
    const provider = inpProvider.value.trim() || 'auto';
    const preset = inpPreset.value.trim();
    // apiKey 留空表示不修改（不上报空串，避免误删已存凭据）
    vscode.postMessage({
      kind: 'settings.apply',
      settings: {
        ...(apiKey ? { apiKey } : {}),
        model,
        baseURL,
        provider,
        preset,
      },
    });
    settingsMsg.textContent = '保存中…';
  });
  btnTrustClear.addEventListener('click', () => {
    vscode.postMessage({ kind: 'trust.clear' });
    renderTrust([]); // 乐观清空；扩展回传 trust.loaded 再同步
  });

  inputEl.addEventListener('input', autosizeInput);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });

  // Esc：优先关闭覆盖面板，其次停止正在进行的会话
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!historyPanel.hidden || !settingsPanel.hidden) {
      closeSheets();
      return;
    }
    if (running) cancel();
  });

  // 空态建议：点击填入输入框（不直接发送，避免误触）
  for (const item of document.querySelectorAll('.suggest-item')) {
    item.addEventListener('click', () => {
      inputEl.value = item.dataset.prompt || '';
      autosizeInput();
      inputEl.focus();
    });
  }

  autosizeInput();

  // 通知扩展：面板已就绪
  vscode.postMessage({ kind: 'ready' });
})();
