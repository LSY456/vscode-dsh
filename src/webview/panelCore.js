/**
 * Webview 面板核心（批次 8 / P1-12）：拆分后的「壳」，只负责一次性建立**共享资源**。
 *
 * 拆分把原来 2244 行的 `media/webview.js` 切成：本文件 + 6 个特性模块 + 事件桥 + 薄入口。
 * 之所以能这么切，是因为这里解决了唯一的硬约束 —— 跨模块共享可变状态：
 *   - `dom`：全部 DOM 引用（只读，插件生命周期内不变），集中一处，元素 id 改名只动这里；
 *   - `state`：全部**可变**状态（原 IIFE 里的闭包变量）。必须显式摆进一个对象 ——
 *     闭包里的 `let x` 无法跨模块共享；若各模块各自 `let` 一份，读到的是各自的快照，
 *     状态会**静默分叉**（比如 `running` 一个模块改成 true、另一个还看到 false）。
 *   - 基础原语：el / fmtDuration / addMessage / scrollBottom / post …（各模块解构后按原名调用）。
 *
 * 各特性模块的工厂签名统一为 `createXxx(ctx)`，从 `ctx` 解构所需依赖；跨模块调用走 `ctx.api`
 * （`api` 是同一个对象，入口用 Object.assign 逐步填满，闭包持有引用，故调用时已是最终态）。
 */
/* global acquireVsCodeApi */

const $ = (id) => document.getElementById(id);

export function createPanel() {
  const vscode = acquireVsCodeApi();

  // -------------------------------------------------------------------------
  // DOM 引用表（只读）
  // -------------------------------------------------------------------------
  const dom = {
    mainEl: $('main'),
    messagesEl: $('messages'),
    emptyEl: $('empty'),
    suggestEl: $('suggest'),
    statusEl: $('status'),
    connDot: $('conn-dot'),
    agentModeEl: $('agent-mode'),
    balanceEl: $('balance-chip'),
    metaBar: $('meta-bar'),
    inputEl: $('input'),
    btnSend: $('btn-send'),
    btnCancel: $('btn-cancel'),
    composerBox: $('composer-box'),
    btnAttach: $('btn-attach'),
    fileInput: $('file-input'),
    btnNew: $('btn-new'),
    btnJump: $('btn-jump'),
    composerHint: $('composer-hint'),
    trajectoryBox: $('trajectory-box'),
    trajectoryEl: $('trajectory'),
    trajCountEl: $('traj-count'),
    btnHistory: $('btn-history'),
    historyPanel: $('history-panel'),
    historyList: $('history-list'),
    btnHistoryClose: $('btn-history-close'),
    btnSettings: $('btn-settings'),
    settingsPanel: $('settings-panel'),
    settingsForm: $('settings-form'),
    inpApiKey: $('inp-apikey'),
    inpModel: $('inp-model'),
    modelHintEl: $('model-catalog-hint'),
    inpBaseURL: $('inp-baseurl'),
    inpProvider: $('inp-provider'),
    inpPreset: $('inp-preset'),
    inpMaxRounds: $('inp-max-rounds'),
    inpMaxContext: $('inp-max-context'),
    inpTemperature: $('inp-temperature'),
    inpMaxTokens: $('inp-max-tokens'),
    btnSettingsRestart: $('btn-settings-restart'),
    btnSettingsClose: $('btn-settings-close'),
    settingsMsg: $('settings-msg'),
    trustListEl: $('trust-list'),
    btnTrustClear: $('btn-trust-clear'),
    pendingBar: $('pending-bar'),
    pendingLabel: $('pending-label'),
    pendingActions: $('pending-actions'),
    stateBanner: $('state-banner'),
    stateBannerTag: $('state-banner-tag'),
    stateBannerText: $('state-banner-text'),
    btnStateAction: $('btn-state-action'),
    sessionTitleEl: $('session-title'),
    btnTrajectory: $('btn-trajectory'),
    btnTrajectoryClose: $('btn-trajectory-close'),
    trajBadge: $('traj-badge'),
    btnPlanMode: $('btn-plan-mode'),
  };

  // -------------------------------------------------------------------------
  // 可变状态（跨模块共享，务必走 state.x，不要在各模块里 let 同名局部）
  // -------------------------------------------------------------------------
  const state = {
    running: false,
    pinned: true,
    trajCount: 0,
    /** 当前生效的 Agent 实现（''=未知）：驱动演示模式横幅与 mock 专属建议项 */
    currentAgent: '',
    /**
     * 输入框的「计划」开关（P2-7）：本轮先出计划、批准后才执行。
     *
     * 状态留在 webview 本地而不是扩展侧：它是"下一条消息怎么发"的输入态，
     * 与模型设置那种要落盘的项目不同，不该因为切了个面板就丢掉。
     */
    planModeEnabled: false,

    // 当前回合的可变容器（新回合重置）
    answerEl: null,
    answerBody: null,
    answerBatcher: null,
    /**
     * 回答的**权威原文**（Markdown 源）。
     *
     * 为什么必须单独存一份：流式期间 DOM 里放的是**渲染后的 HTML**，
     * 此时 `answerBody.textContent` 拿到的是"剥掉标记的纯文本"，
     * 拿它去二次渲染会把标题/列表/代码块全部降级成段落（曾经就是靠读 DOM 拿原文的）。
     */
    answerRaw: '',
    /** 流式渲染的挂起定时器（节流用；null 表示未挂起） */
    answerRenderTimer: null,
    /** 上一次流式渲染的时刻，用于按体量节流 */
    answerRenderedAt: 0,
    reasoningEl: null,
    reasoningBody: null,
    reasoningLabel: null,
    reasoningStartedAt: 0,
    reasoningTimer: null,
    reasoningBatcher: null,
    activityEl: null,
    activityList: null,
    activityMeta: null,
    activityStartedAt: 0,
    activitySteps: 0,
    /** 失败步数：折叠时也要让用户看见"有失败"，否则会误以为过程一切正常 */
    activityFailures: 0,
    /** 过程计时器：折叠状态下靠它让「N 步 · 12.3s」持续走动，给出"还在干活"的反馈 */
    activityTimer: null,

    toolRows: new Map(), // tool -> { row, body, dur, startedAt }
    approvals: new Map(), // approvalId -> entry
    patches: new Map(), // patchId -> entry
    plans: new Map(), // planId -> entry（P2-7）
    approvalTimers: new Map(), // approvalId -> interval id
    patchTimers: new Map(), // patchId -> interval id
    planTimers: new Map(), // planId -> interval id
    pendingTicker: null,
    pendingCountdownEl: null,

    /** 工作区信任快照：{ blocked, banner:{tag,text,actionLabel} }；null = 尚未收到 / 已信任 */
    trustGate: null,
    /** 演示模式横幅文案；null = 当前不在演示模式 */
    demoBannerMessage: null,
    /** 横幅按钮的动作：'trust' | 'settings' | ''（点击时据此派发） */
    bannerAction: '',

    // 图片附件（P2-4）
    /** 已暂存待发送的图片。发出后由 user.message 回显确认再清空（发送失败时保留，可重试）。 */
    stagedImages: [],
    /** 已发出图片的缩略图：clientId -> data URL。用户气泡据此渲染，不再回传 base64。 */
    sentImagePreviews: new Map(),
    /** 本次发送携带的 clientId 列表：只有它们该在回显时被"提交"。 */
    inFlightImageIds: [],
    imageSeq: 0,
    noticeTimer: null,
  };

  // -------------------------------------------------------------------------
  // 基础原语
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
    return dom.mainEl.scrollHeight - dom.mainEl.scrollTop - dom.mainEl.clientHeight <= 32;
  }

  function scrollBottom(force) {
    if (force || state.pinned) {
      dom.mainEl.scrollTop = dom.mainEl.scrollHeight;
      state.pinned = true;
      dom.btnJump.hidden = true;
    } else {
      dom.btnJump.hidden = false;
    }
  }

  /**
   * 空态与消息区互斥：消息区一有内容就收起欢迎块，空了就把它交还回来。
   *
   * 可见性只由「消息区是否为空」这一处决定。早先是在 addMessage 里单向隐藏、在 clearMessages 里
   * 单向恢复，各写一半 —— 于是任何"清空后紧跟一条消息"的路径都会把欢迎块永久藏掉：点「新建会话」
   * 时紧跟的正是「已新建会话：sess_xxx」那条系统行，新页面就只剩一行会话号（用户报的就是这个）。
   */
  function syncEmptyState() {
    dom.emptyEl.style.display = dom.messagesEl.childElementCount ? 'none' : '';
  }

  function addMessage(node) {
    dom.messagesEl.appendChild(node);
    syncEmptyState();
    scrollBottom();
    return node;
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

  /**
   * 前端渲染诊断上报（走扩展的日志通道）。
   *
   * 用途只有两个：某条事件渲染时抛错、或收到前端不认识的事件（协议多了新东西而前端没跟上）。
   * 这两种情况此前都是**彻底静默**的 —— 界面上只表现为"没反应"，而没有任何线索能区分
   * "协议漂移"与"UI 坏了"。只上报，不改任何产品行为，也不向用户弹窗。
   */
  function reportDiag(level, method, message) {
    vscode.postMessage({
      kind: 'ui.diag',
      diag: { level, method: method ? String(method) : undefined, message: message ? String(message) : undefined },
    });
  }

  // 滚动锁定：只在用户本来就在底部时自动跟随，否则浮出「有新内容」按钮
  dom.mainEl.addEventListener('scroll', () => {
    state.pinned = nearBottom();
    if (state.pinned) dom.btnJump.hidden = true;
  });
  dom.btnJump.addEventListener('click', () => scrollBottom(true));

  // api 先建空对象，入口用 Object.assign 逐步填满；各模块持有的是同一个引用，
  // 因此它们互相调用时（只发生在事件回调 / 启动阶段，不发生在模块构造期）拿到的是完整集。
  const api = {};

  return { vscode, $, dom, state, api, el, fmtDuration, nearBottom, scrollBottom, syncEmptyState, addMessage, copyText, addCopyAction, reportDiag };
}
