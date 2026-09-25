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
import { streamRenderIntervalMs } from '../src/webview/streamRenderPolicy.js';
import { SUGGESTION_POOL, SUGGEST_ICONS, pickSuggestions, demoSuggestions } from '../src/webview/suggestions.js';

(function () {
  'use strict';

  // eslint-disable-next-line no-undef
  const vscode = acquireVsCodeApi();

  const $ = (id) => document.getElementById(id);
  const mainEl = $('main');
  const messagesEl = $('messages');
  const emptyEl = $('empty');
  const suggestEl = $('suggest');
  const statusEl = $('status');
  const connDot = $('conn-dot');
  const agentModeEl = $('agent-mode');
  const metaBar = $('meta-bar');
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
  const stateBanner = $('state-banner');
  const stateBannerTag = $('state-banner-tag');
  const stateBannerText = $('state-banner-text');
  const btnStateAction = $('btn-state-action');
  const sessionTitleEl = $('session-title');
  const btnTrajectory = $('btn-trajectory');
  const btnTrajectoryClose = $('btn-trajectory-close');
  const trajBadge = $('traj-badge');

  let running = false;
  let pinned = true;
  let trajCount = 0;
  /** 当前生效的 Agent 实现（''=未知）：驱动演示模式横幅与 mock 专属建议项 */
  let currentAgent = '';

  // 当前回合的可变容器（新回合重置）
  let answerEl = null;
  let answerBody = null;
  let answerBatcher = null;
  /**
   * 回答的**权威原文**（Markdown 源）。
   *
   * 为什么必须单独存一份：流式期间 DOM 里放的是**渲染后的 HTML**，
   * 此时 `answerBody.textContent` 拿到的是"剥掉标记的纯文本"，
   * 拿它去二次渲染会把标题/列表/代码块全部降级成段落（曾经就是靠读 DOM 拿原文的）。
   */
  let answerRaw = '';
  /** 流式渲染的挂起定时器（节流用；-1 表示未挂起） */
  let answerRenderTimer = null;
  /** 上一次流式渲染的时刻，用于按体量节流 */
  let answerRenderedAt = 0;
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
  /** 失败步数：折叠时也要让用户看见"有失败"，否则会误以为过程一切正常 */
  let activityFailures = 0;
  /** 过程计时器：折叠状态下靠它让「N 步 · 12.3s」持续走动，给出"还在干活"的反馈 */
  let activityTimer = null;

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

  /**
   * 空态与消息区互斥：消息区一有内容就收起欢迎块，空了就把它交还回来。
   *
   * 可见性只由「消息区是否为空」这一处决定。早先是在 addMessage 里单向隐藏、在 clearMessages 里
   * 单向恢复，各写一半 —— 于是任何"清空后紧跟一条消息"的路径都会把欢迎块永久藏掉：点「新建会话」
   * 时紧跟的正是「已新建会话：sess_xxx」那条系统行，新页面就只剩一行会话号（用户报的就是这个）。
   */
  function syncEmptyState() {
    emptyEl.style.display = messagesEl.childElementCount ? 'none' : '';
  }

  function addMessage(node) {
    messagesEl.appendChild(node);
    syncEmptyState();
    scrollBottom();
    return node;
  }

  // -------------------------------------------------------------------------
  // 空态建议项
  // -------------------------------------------------------------------------

  function suggestionButton(item) {
    const btn = el('button', 'suggest-item');
    btn.type = 'button';
    btn.dataset.prompt = item.prompt;
    if (item.demoOnly) {
      btn.dataset.demoOnly = '1';
      // 演示模式专属项只在 mock 下露面（真实模型不需要关键字「咒语」这把钥匙）
      btn.hidden = currentAgent !== 'mock';
    }
    const icon = el('span', 'suggest-icon');
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = SUGGEST_ICONS[item.icon] || '';
    const body = el('span', 'suggest-body');
    body.appendChild(el('b', '', item.bold));
    body.appendChild(document.createTextNode(' ' + item.text));
    btn.appendChild(icon);
    btn.appendChild(body);
    return btn;
  }

  /**
   * 重建空态建议项。每次空态出现（首屏 / 新建会话 / 切换会话）都换一组：
   * 池子与轮换规则见 src/webview/suggestions.js —— 写死的几条看第二眼就成装饰了。
   */
  function renderSuggestions(seed) {
    if (!suggestEl) return;
    suggestEl.textContent = '';
    for (const item of pickSuggestions(SUGGESTION_POOL, seed)) {
      suggestEl.appendChild(suggestionButton(item));
    }
    for (const item of demoSuggestions(SUGGESTION_POOL)) {
      suggestEl.appendChild(suggestionButton(item));
    }
  }

  const STATUS_LABEL = {
    connected: '已连接',
    connecting: '连接中…',
    starting: '启动中…',
    stopped: '未启动',
    disabled: '仅 UI 模式',
    // 受限模式：工作区未被信任，daemon 刻意不启动（它不是故障，而是缺一个前置条件）
    restricted: '受限模式',
    error: '错误',
  };

  function setStatus(status, detail) {
    statusEl.className = 'status ' + (status || '');
    connDot.className = 'dot ' + (status || '');
    const label = STATUS_LABEL[status] || status || '未知';
    statusEl.textContent = detail ? label + ' — ' + detail : label;
    statusEl.title = detail || '';
  }

  /** 徽标只显示「当前模型」；mock 没有模型可显示，才回退到这个短标签。 */
  const AGENT_LABEL = { mock: '演示模式' };
  const AGENT_TITLE = {
    mock: '未接入真实模型：回复由内置模拟 Agent 生成（关键词语义，非模型输出）',
    real: '当前使用真实模型 Agent',
  };
  /** 演示模式横幅文案：按 daemon 回报的成因区分措辞，缺失时给通用兜底 */
  const DEMO_REASON_TEXT = {
    'no-api-key': '未配置模型 Key，回复由内置模拟 Agent 生成，不是真实模型的输出。',
    'forced-mock': 'daemon 被显式指定为 mock（agent=mock），回复不是真实模型的输出。',
  };
  const DEMO_FALLBACK_TEXT = '当前由内置模拟 Agent 生成回复，不是真实模型的输出。';

  // -------------------------------------------------------------------------
  // 状态横幅（受限模式 / 演示模式共用同一块 UI）
  // -------------------------------------------------------------------------

  /** 工作区信任快照：{ blocked, banner:{tag,text,actionLabel} }；null = 尚未收到 / 已信任 */
  let trustGate = null;
  /** 演示模式横幅文案；null = 当前不在演示模式 */
  let demoBannerMessage = null;
  /** 横幅按钮的动作：'trust' | 'settings' | ''（点击时据此派发） */
  let bannerAction = '';

  /**
   * 渲染状态横幅。两个来源互斥，**受限模式优先**：
   * 未受信任时 daemon 根本没启动，此时再说"没配 Key 所以是模拟回复"纯属误导。
   */
  function renderStateBanner() {
    const restricted = trustGate && trustGate.blocked ? trustGate.banner : null;
    if (restricted) {
      showStateBanner({
        tag: restricted.tag,
        text: restricted.text,
        action: 'trust',
        actionLabel: restricted.actionLabel,
      });
      return;
    }
    if (demoBannerMessage) {
      showStateBanner({
        tag: AGENT_LABEL.mock,
        text: demoBannerMessage,
        action: 'settings',
        actionLabel: '配置模型',
      });
      return;
    }
    showStateBanner(null);
  }

  function showStateBanner(state) {
    if (!state) {
      stateBanner.hidden = true;
      bannerAction = '';
      return;
    }
    stateBannerTag.textContent = state.tag;
    stateBannerText.textContent = state.text;
    btnStateAction.textContent = state.actionLabel;
    bannerAction = state.action || '';
    stateBanner.hidden = false;
  }

  /** 工作区信任（init 快照 / 用户信任后推来的 trust.info） */
  function setTrustGate(gate) {
    trustGate = gate || null;
    renderStateBanner();
  }

  /**
   * 同步 Agent 实现信息（init 快照 / 每次握手后的 agent.info）。
   *
   * 这是"消除静默降级成 mock"的落点：没配 Key 时要**显式告诉用户**现在不是真模型，
   * 而不是让关键字模拟循环的回复冒充模型回答。
   */
  function setAgentInfo(state) {
    const agent = state && state.agent;
    const model = state && state.model;
    currentAgent = agent || '';
    const isMock = agent === 'mock';

    // mock 专属入口（关键字"咒语"演示）不混在真实模型的主路径里
    for (const node of document.querySelectorAll('[data-demo-only]')) {
      node.hidden = !isMock;
    }

    if (!agent && !model) {
      agentModeEl.hidden = true;
      demoBannerMessage = null;
      renderStateBanner();
      return;
    }
    agentModeEl.className = 'meta-chip' + (isMock ? ' warn' : '');
    // 只显示当前模型名：`真实模型 · ` 这个定语是多余的——能列出模型名就说明在跑真模型，
    // 而"当前不是真模型"由状态横幅专门负责讲清（见 DEMO_REASON_TEXT）。
    // mock 下模型名没有意义（关键字模拟不调用模型），所以只显示「演示模式」。
    agentModeEl.textContent = isMock ? AGENT_LABEL.mock : model || '';
    agentModeEl.hidden = !agentModeEl.textContent;
    agentModeEl.title = AGENT_TITLE[agent] || '';

    const reason = (state && state.agentReason) || '';
    demoBannerMessage = isMock ? DEMO_REASON_TEXT[reason] || DEMO_FALLBACK_TEXT : null;
    renderStateBanner();
  }

  /**
   * 记录当前会话号。
   *
   * 会话号是排障信息（`.dsh/trajectory/<sessionId>.jsonl` 就按它命名），但对使用者毫无意义，
   * 常驻在状态行上纯属噪音（原先那枚 `session sess_xxx` 徽标已移除）。
   * 现改为落到 `#meta-bar` 的 `data-session` 与悬停提示：平时看不见，需要时悬停 / devtools 可查。
   */
  function setSession(id) {
    const text = id ? String(id) : '';
    metaBar.dataset.session = text;
    metaBar.title = text ? 'session ' + text : '';
  }

  /** 会话标题：有就显示在顶栏标识右侧，没有则整块收起（不留空白占位） */
  function setSessionTitle(title) {
    const text = String(title || '').trim();
    sessionTitleEl.textContent = text;
    sessionTitleEl.hidden = !text;
    sessionTitleEl.title = text;
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

  /**
   * 角色标记：给"谁在说话"一个固定视觉锚点。
   * 弃用左右对齐气泡的原因——窄侧栏里右对齐会压缩长 prompt，且 assistant 没有锚点，
   * 而 agent 输出的是报告/代码而非寒暄，文档式的「角色列 + 全宽正文」更接近标准 agent 工具。
   */
  function roleMark(text, cls) {
    return el('span', 'role ' + cls, text);
  }

  // 用户回合：角色标记 + 消息体 + 「Agent 看到了什么」上下文 chip（上下文保真是这个插件的核心卖点）
  function addUser(text, attachments) {
    const turn = el('div', 'turn user');
    turn.appendChild(roleMark('你', 'user'));
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
    turn.appendChild(roleMark('dsh', 'agent'));
    const body = el('div', 'message assistant md');
    body.innerHTML = renderMarkdown(md);
    turn.appendChild(body);
    addMessage(turn);
    return turn;
  }

  /**
   * 流式渲染：对**累积全文**做一次正规渲染，所以屏幕上从头到尾都是排版好的内容，
   * 不会出现 `|`、``` 、`**`、以及表格/代码里那些符号的原始形态。
   *
   * 节流间隔由 `streamRenderIntervalMs`（src/webview/streamRenderPolicy.js）给出：
   * 那里记录了实测成本与"为什么不能逐帧渲染"。流式渲染只影响过程中的观感，
   * 结束时还会完整渲染一次，最终结果与渲染时机无关。
   */
  function renderAnswerStream() {
    if (!answerBody) return;
    answerRenderedAt = Date.now();
    answerBody.innerHTML = renderMarkdown(answerRaw);
    scrollBottom();
  }

  /** 按体量节流地安排一次流式渲染：能渲就立刻渲，否则排一个尾随补渲。 */
  function scheduleAnswerRender() {
    if (!answerBody) return;
    const wait = streamRenderIntervalMs(answerRaw.length) - (Date.now() - answerRenderedAt);
    if (wait <= 0) {
      cancelAnswerRender();
      renderAnswerStream();
      return;
    }
    if (answerRenderTimer != null) return;
    answerRenderTimer = setTimeout(() => {
      answerRenderTimer = null;
      renderAnswerStream();
    }, wait);
  }

  function cancelAnswerRender() {
    if (answerRenderTimer != null) {
      clearTimeout(answerRenderTimer);
      answerRenderTimer = null;
    }
  }

  function ensureAnswer() {
    if (answerEl) return;
    answerEl = el('div', 'turn assistant');
    answerEl.appendChild(roleMark('dsh', 'agent'));
    answerBody = el('div', 'message assistant md streaming', '');
    answerEl.appendChild(answerBody);
    addMessage(answerEl);
    answerRaw = '';
    // 让首次增量立刻渲染（避免"前 80ms 屏幕还是空的"，也便于同步断言）
    answerRenderedAt = Date.now() - streamRenderIntervalMs(0);
    answerBatcher = createBatcher((text) => {
      answerRaw += text;
      scheduleAnswerRender();
    });
  }

  function appendAssistant(delta) {
    ensureAnswer();
    answerBatcher.append(delta);
  }

  // 流式期间按体量节流地渲染 Markdown；结束时再做一次完整定妆渲染。
  function finishAssistant() {
    if (answerBatcher) answerBatcher.flush();
    cancelAnswerRender();
    if (answerBody) {
      const raw = answerRaw;
      answerBody.classList.remove('streaming');
      answerBody.innerHTML = renderMarkdown(raw);
      addCopyAction(answerEl, raw);
      scrollBottom();
    }
    finishReasoning();
    stopActivityTimer();
    answerEl = null;
    answerBody = null;
    answerBatcher = null;
    answerRaw = '';
    answerRenderedAt = 0;
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

  // ---- 过程：把工具调用聚合成一条时间线，默认折叠，点开才看输入/输出
  //
  // 为什么默认折叠：工具调用属于"过程"，而回答才是用户要的结论。展开状态下列表会把结论
  // 一路挤出视野（实测一轮十来步就要滚好几屏），与"回答是主角"的层级正好相反。
  // 折叠后头部仍持续显示「N 步 · 耗时 · N 失败」，既有进度反馈，也不占版面。
  function ensureActivity() {
    if (activityEl) return;
    activityEl = el('section', 'activity collapsed');
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
    activityFailures = 0;
    ensureActivityTimer();
    addMessage(activityEl);
  }

  function ensureActivityTimer() {
    if (activityTimer) return;
    activityTimer = setInterval(updateActivityMeta, 1000);
  }

  function stopActivityTimer() {
    if (activityTimer) {
      clearInterval(activityTimer);
      activityTimer = null;
    }
  }

  function updateActivityMeta() {
    if (!activityMeta) return;
    activityMeta.textContent =
      activitySteps +
      ' 步 · ' +
      fmtDuration(Date.now() - activityStartedAt) +
      (activityFailures ? ' · ' + activityFailures + ' 失败' : '');
    activityMeta.className = 'activity-meta' + (activityFailures ? ' err' : '');
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
    ensureActivityTimer(); // 同一轮里可能"回答 → 再调工具"，计时器要重新跑起来
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
    toolRows.set(tool, { row, line, body, dur, startedAt: Date.now() });
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
    if (!executed.ok) {
      // 失败**不**自动展开正文：一轮里连错几次（例如搜索无结果被反复重试）时，自动展开会
      // 瞬间把结论顶出好几屏。改为行内标注 + 头部计数透出，要追细节用户自己点开。
      activityFailures += 1;
      entry.dur.classList.add('err');
      entry.line.appendChild(el('span', 'badge err', '失败'));
    }
    toolRows.delete(tool);
    updateActivityMeta();
    scrollBottom();
  }

  function resetTurn() {
    finishReasoning();
    stopActivityTimer();
    activityEl = null;
    activityList = null;
    activityMeta = null;
    activitySteps = 0;
    activityFailures = 0;
    toolRows.clear();
  }

  // -------------------------------------------------------------------------
  // 审批卡（Human-in-the-Loop）
  // -------------------------------------------------------------------------

  /**
   * 让卡片标题行成为开合开关（与「过程」时间线同一套实现：常量 ▾ + CSS 旋转）。
   *
   * 为什么决策后要折叠：决策前卡片要占十几行（原因 + 完整命令 + 操作按钮），决策后它
   * 已经不需要再操作，全展开会把后续消息顶出视野；而用户又需要能回看「当时请求的是什么
   * 命令」，所以做的是"自动折叠 + 可再展开"，而不是把一张死卡片留在原地。
   *
   * 折叠范围是 `.card-body`（正文），标题行始终可见——结论徽标（已接受 / 已拒绝 / 已过期）
   * 就落在标题行上，折叠后依然读得到结果。
   */
  function attachCollapse(card, title) {
    const chev = el('span', 'chev', '▾');
    title.insertBefore(chev, title.firstChild);
    title.classList.add('clickable');
    title.tabIndex = 0;
    title.setAttribute('role', 'button');
    const setCollapsed = (collapsed) => {
      card.classList.toggle('collapsed', collapsed);
      title.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    };
    const toggle = () => setCollapsed(!card.classList.contains('collapsed'));
    title.addEventListener('click', toggle);
    title.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
    });
    setCollapsed(false);
    return { setCollapsed };
  }

  /**
   * 决策后收掉已无意义的操作按钮：统一置 disabled，并隐藏「决策类」按钮
   * ——留一排点了没反应的按钮，用户会以为操作没生效（实测就是这么被误解的）。
   * 补丁卡的「打开 Diff」是只读审查入口，标 data-keep 予以保留，决策后仍可回看改了什么。
   * 整行都收空了就把这一行也隐藏，免得留下一片空白。
   */
  function retireActions(entry) {
    for (const b of entry.buttons) {
      b.disabled = true;
      if (b.dataset.keep !== '1') b.hidden = true;
    }
    if (entry.actions && [...entry.actions.children].every((c) => c.hidden)) {
      entry.actions.hidden = true;
    }
  }

  /** 折叠已决策的卡片（老会话恢复出来的挂起项没有控制器，做空值保护）。 */
  function collapseEntry(entry) {
    entry?.collapse?.setCollapsed(true);
  }

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
    retireActions(entry);
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
    // 结论已经落到标题行的徽标上，正文（命令 + 按钮）随之折叠
    collapseEntry(entry);
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

    // 正文单独成块：折叠时整块隐藏，标题行（含结论徽标）保持可见
    const body = el('div', 'card-body');
    if (p.reason) body.appendChild(el('div', 'card-reason', p.reason));
    body.appendChild(el('pre', 'code-block', JSON.stringify(p.input ?? {}, null, 2)));

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

    if (p.expiresAt) body.appendChild(countdown);
    body.appendChild(actions);
    card.appendChild(body);
    const collapse = attachCollapse(card, title);
    addMessage(card);

    const entry = {
      data: p,
      card,
      badge,
      countdown: p.expiresAt ? countdown : null,
      actions,
      buttons: [btnReject, btnAccept, btnTrust],
      collapse,
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
      // 表态即收按钮 + 折叠：卡片不再占屏，结论落到标题行徽标上
      retireActions(entry);
      if (action === 'reject') {
        entry.decided = true;
        entry.card.classList.add('decided');
      }
      if (entry.badge) {
        if (action === 'reject') {
          entry.badge.className = 'badge err';
          entry.badge.textContent = '已拒绝';
        } else {
          // 已回执但尚未落地：不能沿用「待审查」，否则折叠后看起来像没生效
          entry.badge.className = 'badge running';
          entry.badge.textContent = '已提交，等待应用';
        }
      }
      collapseEntry(entry);
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

    const body = el('div', 'card-body');
    body.appendChild(el('div', 'card-sub', p.path || ''));
    if (p.description) body.appendChild(el('div', 'card-reason', p.description));

    const actions = el('div', 'card-actions');
    const btnDiff = el('button', '', '打开 Diff');
    const btnReject = el('button', 'danger', '拒绝');
    const btnAccept = el('button', 'ok-btn', '应用');
    const btnEdit = el('button', 'ok-btn', '编辑后应用');
    btnDiff.type = btnReject.type = btnAccept.type = btnEdit.type = 'button';
    // 只读审查入口：决策后仍然有用（回看改了哪儿），故豁免于"决策后收按钮"
    btnDiff.dataset.keep = '1';
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
      body.appendChild(countdown);
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
    body.appendChild(actions);
    card.appendChild(body);
    const collapse = attachCollapse(card, title);
    addMessage(card);

    patches.set(p.patchId, {
      data: p,
      card,
      badge,
      countdown,
      actions,
      buttons: [btnDiff, btnReject, btnAccept, btnEdit],
      collapse,
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
      retireActions(entry);
      if (entry.badge) {
        entry.badge.className = 'badge err';
        entry.badge.textContent = '已过期';
      }
      if (entry.countdown) entry.countdown.textContent = '⏱ 已过期（按拒绝处理）';
      collapseEntry(entry);
    }
    updatePendingBar();
  }

  function updatePatchCard(result) {
    stopPatchTimer(result.patchId);
    const entry = patches.get(result.patchId);
    if (entry) {
      entry.decided = true;
      entry.card.classList.add('decided');
      retireActions(entry);
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
      // 失败原因挂在 card 上而不是 card-body 内：折叠后仍然可见，
      // 否则标题只写「应用失败」，用户还得手动展开才知道为什么失败。
      if (result.error) entry.card.appendChild(el('pre', 'code-block', result.error));
      collapseEntry(entry);
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

  /**
   * 迹线是审计信息、不是对话内容，所以不主动弹面板打断阅读：
   * 只在顶栏按钮上亮出计数，用户想看时自己点开。
   */
  function addTrajectory(t) {
    trajCount += 1;
    btnTrajectory.hidden = false;
    trajBadge.textContent = String(trajCount);
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
   *
   * 「新建会话」不再往消息流里插一句「已新建会话：sess_xxx」：
   *  ① 会话号对使用者没有意义（排障那份已挪到 #meta-bar 的 data-session / 悬停提示）；
   *  ② 那句系统行会让消息区变成"非空"，把空态欢迎块（标记 + 标题 + 可点的起点）当场顶掉，
   *     新会话只剩一行会话号 —— 这正是"点新建会话后页面一片空白"的成因。空态本身就是
   *     「已新建」的反馈，不需要第二份文案。
   */
  function resetForSession(sessionId, reason) {
    clearMessages();
    setSession(sessionId);
    // 顺带换一组起点：同池按会话号轮换（见 src/webview/suggestions.js）
    renderSuggestions(sessionId);
    if (reason === 'switch') addSystem('已切换到该会话，可继续对话');
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
    syncEmptyState();
    trajectoryEl.textContent = '';
    trajectoryBox.hidden = true;
    trajCount = 0;
    trajCountEl.textContent = '';
    trajBadge.textContent = '';
    btnTrajectory.hidden = true;
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
    cancelAnswerRender();
    if (reasoningTimer) clearInterval(reasoningTimer);
    reasoningTimer = null;
    reasoningEl = null;
    reasoningBody = null;
    reasoningLabel = null;
    reasoningBatcher = null;
    answerEl = null;
    answerBody = null;
    answerBatcher = null;
    answerRaw = '';
    answerRenderedAt = 0;
    stopActivityTimer();
    activityEl = null;
    activityList = null;
    activityMeta = null;
    activitySteps = 0;
    activityFailures = 0;
    setSession('');
    setSessionTitle('');
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
    setSessionTitle(rec.title);
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

  /** 打开指定覆盖面板（history / settings / trajectory 三者互斥，同一时刻只开一个）。 */
  function openSheet(which) {
    historyPanel.hidden = which !== 'history';
    settingsPanel.hidden = which !== 'settings';
    trajectoryBox.hidden = which !== 'trajectory';
    if (which !== 'settings') return;
    settingsMsg.textContent = '';
    btnSettingsRestart.hidden = true;
    btnSettingsRestart.disabled = false;
    vscode.postMessage({ kind: 'settings.get' });
    vscode.postMessage({ kind: 'trust.list' }); // B1：同步加载信任规则
  }

  function closeSheets() {
    historyPanel.hidden = true;
    settingsPanel.hidden = true;
    trajectoryBox.hidden = true;
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
        setSessionTitle(params.title);
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
      case 'session.ended': {
        setRunning(false);
        finishAssistant();
        // reason 是协议里的英文枚举，直接展示等于把 "error" 这种内部字眼丢给用户；
        // 而"会话为什么结束"恰恰是此刻最该看懂的信息——早先只写 completed/error，
        // 用户既不知道发生了什么，也不知道停在哪一步（本次修复的原始反馈之一）。
        const endedLabels = { completed: '已完成', canceled: '已取消', error: '出错中止（详见上方错误）' };
        addSystem('会话结束：' + (endedLabels[params.reason] || params.reason || '已完成'));
        break;
      }
      case 'history.loaded':
        renderHistoryMessages(params);
        break;
      case 'agent.info':
        // 扩展本地事件（非 daemon 协议）：每次握手后同步当前 Agent 实现
        setAgentInfo(params);
        break;
      case 'trust.info':
        // 扩展本地事件：工作区信任状态（受限模式下 daemon 不启动，拿不到任何握手事件，
        // 所以撤下「受限模式」横幅只能靠这条）
        setTrustGate(params);
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
        setTrustGate(msg.state && msg.state.trust);
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
  // 迹线：按需打开（不主动弹面板打断阅读），关闭与其它覆盖面板同一套逻辑
  btnTrajectory.addEventListener('click', () => {
    if (trajectoryBox.hidden) openSheet('trajectory');
    else closeSheets();
  });
  btnTrajectoryClose.addEventListener('click', closeSheets);
  // 演示模式横幅 → 一键进入模型配置（配好 Key 并重启 daemon 后横幅自动撤下）
  // 状态横幅的动作按钮：受限模式去信任工作区，演示模式去配置模型。
  // 用 bannerAction 这一个出口派发 —— 横幅是同一块 UI，动作却由当前状态决定。
  btnStateAction.addEventListener('click', () => {
    if (bannerAction === 'trust') vscode.postMessage({ kind: 'trust.manage' });
    else if (bannerAction === 'settings') openSheet('settings');
  });
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
    if (!historyPanel.hidden || !settingsPanel.hidden || !trajectoryBox.hidden) {
      closeSheets();
      return;
    }
    if (running) cancel();
  });

  // 空态建议：点击填入输入框（不直接发送，避免误触）。
  // 用事件委派而不是逐项挂监听：建议项现在按会话号轮换、每次空态整批重建，
  // 逐项 addEventListener 会在重建后全部失效（点上去毫无反应）。
  if (suggestEl) {
    suggestEl.addEventListener('click', (e) => {
      const node = e.target;
      const item = node && typeof node.closest === 'function' ? node.closest('.suggest-item') : null;
      if (!item) return;
      inputEl.value = item.dataset.prompt || '';
      autosizeInput();
      inputEl.focus();
    });
  }

  // 首屏也要有一组起点（此时还没有会话号，用空 seed 的确定性结果）
  renderSuggestions('');

  autosizeInput();

  /**
   * 样式表自检：样式若被 CSP 拦掉，脚本照常工作、界面只是"退化成浏览器默认样式"，
   * 从行为上完全看不出异常 —— 实测就这样静默退化过，排查花了很久才定位到
   * 「脚本靠 nonce 放行、样式只能靠 CSP 的 URL 匹配」这个差异。
   * 判据见下方两条件：取不到 webview.css 的哨兵变量、且一个样式表都没有。
   */
  function checkStylesLoaded() {
    // 走 window.* 而不是裸全局：静态预览骨架（jsdom）只挂了 window/document 等少数名字，
    // 裸 getComputedStyle 会 ReferenceError，把整支脚本打断。
    const view = typeof window !== 'undefined' ? window : globalThis;
    const probe = view
      .getComputedStyle(document.documentElement)
      .getPropertyValue('--dsh-role-col')
      .trim();
    // 判据要同时满足三条才告警（缺任一条都会在 jsdom 测试 / 静态预览里误报：
    // 那两处既不解析自定义属性、也不经过 CSP）：
    //   ① 文档里确实声明了样式（<style nonce> 或 <link rel=stylesheet>）；
    //   ② 生效的样式表数量为 0（被 CSP 拦掉时 <style> 元素仍在 DOM，但不生成样式表）；
    //   ③ 哨兵变量取不到值。
    const declared = document.querySelector('style[nonce], link[rel="stylesheet"]');
    if (!declared || probe || document.styleSheets.length > 0) return;
    console.error('[dsh] webview.css 未生效（无任何样式表）：样式表很可能被 CSP 拦下。');
    const bar = document.createElement('div');
    bar.id = 'style-warning';
    bar.textContent =
      '⚠ 面板样式表未加载，界面已退化为浏览器默认样式。请打开开发者工具 Console 查看是否被 CSP 拦截。';
    // 用 CSSOM 写入而不用 style 属性：CSP 的 style-src 拦的是标记里解析出来的 style 属性，
    // CSSOM 写入不在其管辖内 —— 否则这条"样式没加载"的提示自己也会被拦成裸文本。
    bar.style.cssText =
      'padding:8px 10px;font:12px/1.5 sans-serif;background:#5a1d1d;color:#ffd9d9;border-bottom:2px solid #ff6b6b';
    document.body.insertBefore(bar, document.body.firstChild);
  }
  checkStylesLoaded();

  // 通知扩展：面板已就绪
  vscode.postMessage({ kind: 'ready' });
})();
