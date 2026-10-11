/**
 * 状态栏 / 会话标识 / 状态横幅 / 空态建议项（批次 8 从 media/webview.js 抽出）。
 *
 * 这一组是"面板的被动显示面"：状态行、Agent 徽标、余额 chip、会话标题、运行态、横幅、起点建议。
 * 它们几乎不产生副作用（除 setRunning 会改输入区按钮），因此归为一处最省心。
 */
import { daemonStateLabel } from '../statusLabel.ts';
import { SUGGESTION_POOL, SUGGEST_ICONS, pickSuggestions, demoSuggestions } from './suggestions.js';

export function createStatusBar(ctx) {
  const { el, dom, state } = ctx;
  const {
    statusEl,
    connDot,
    agentModeEl,
    balanceEl,
    metaBar,
    sessionTitleEl,
    btnSend,
    btnCancel,
    composerHint,
    stateBanner,
    stateBannerTag,
    stateBannerText,
    btnStateAction,
    suggestEl,
  } = dom;

  // -------------------------------------------------------------------------
  // 状态行
  // -------------------------------------------------------------------------

  function setStatus(status, detail) {
    statusEl.className = 'status ' + (status || '');
    connDot.className = 'dot ' + (status || '');
    // 文案走共享模块（src/statusLabel.ts）：状态栏与面板不会各写一份、也不会漂移
    const label = daemonStateLabel(status);
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

  /**
   * 渲染状态横幅。两个来源互斥，**受限模式优先**：
   * 未受信任时 daemon 根本没启动，此时再说"没配 Key 所以是模拟回复"纯属误导。
   */
  function renderStateBanner() {
    const restricted = state.trustGate && state.trustGate.blocked ? state.trustGate.banner : null;
    if (restricted) {
      showStateBanner({
        tag: restricted.tag,
        text: restricted.text,
        action: 'trust',
        actionLabel: restricted.actionLabel,
      });
      return;
    }
    if (state.demoBannerMessage) {
      showStateBanner({
        tag: AGENT_LABEL.mock,
        text: state.demoBannerMessage,
        action: 'settings',
        actionLabel: '配置模型',
      });
      return;
    }
    showStateBanner(null);
  }

  function showStateBanner(banner) {
    if (!banner) {
      stateBanner.hidden = true;
      state.bannerAction = '';
      return;
    }
    stateBannerTag.textContent = banner.tag;
    stateBannerText.textContent = banner.text;
    btnStateAction.textContent = banner.actionLabel;
    state.bannerAction = banner.action || '';
    stateBanner.hidden = false;
  }

  /** 工作区信任（init 快照 / 用户信任后推来的 trust.info） */
  function setTrustGate(gate) {
    state.trustGate = gate || null;
    renderStateBanner();
  }

  /**
   * 同步 Agent 实现信息（init 快照 / 每次握手后的 agent.info）。
   *
   * 这是"消除静默降级成 mock"的落点：没配 Key 时要**显式告诉用户**现在不是真模型，
   * 而不是让关键字模拟循环的回复冒充模型回答。
   */
  function setAgentInfo(info) {
    const agent = info && info.agent;
    const model = info && info.model;
    state.currentAgent = agent || '';
    const isMock = agent === 'mock';

    // mock 专属入口（关键字"咒语"演示）不混在真实模型的主路径里
    for (const node of document.querySelectorAll('[data-demo-only]')) {
      node.hidden = !isMock;
    }

    if (!agent && !model) {
      agentModeEl.hidden = true;
      state.demoBannerMessage = null;
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

    const reason = (info && info.agentReason) || '';
    state.demoBannerMessage = isMock ? DEMO_REASON_TEXT[reason] || DEMO_FALLBACK_TEXT : null;
    renderStateBanner();
  }

  /**
   * 账户余额 chip（状态行，模型名右侧）。
   *
   * **只在"可用"时显示**：拿不到（未配 Key / 非 DeepSeek 官方端点 / 上游没这个接口）
   * 就整块隐藏，而不是显示 `0` 或 `--` —— 0 余额是个很重的结论，不能靠兜底值给出。
   * 文案、警示色与悬停提示都由扩展算好（唯一出口在 `src/accountBalance.ts`），这里只渲染。
   */
  function setBalance(params) {
    const p = params || {};
    if (!p.available || !p.text) {
      balanceEl.hidden = true;
      balanceEl.textContent = '';
      balanceEl.title = '';
      return;
    }
    balanceEl.hidden = false;
    balanceEl.textContent = p.text;
    // 余额不足用既有的警示色（复用 .meta-chip.warn，不另造一套）
    balanceEl.className = 'meta-chip' + (p.insufficient ? ' warn' : '');
    balanceEl.title = p.title || '';
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
    state.running = r;
    btnSend.disabled = r;
    btnCancel.hidden = !r;
    btnSend.textContent = r ? '处理中…' : '发送';
    composerHint.textContent = r ? 'Esc 停止当前回答' : 'Enter 发送 · Shift+Enter 换行 · 可粘贴截图';
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
      btn.hidden = state.currentAgent !== 'mock';
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

  return {
    setStatus,
    setAgentInfo,
    setBalance,
    setSession,
    setSessionTitle,
    setRunning,
    setTrustGate,
    renderSuggestions,
  };
}
