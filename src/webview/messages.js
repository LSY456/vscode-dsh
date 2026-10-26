/**
 * 消息流渲染（批次 8 从 media/webview.js 抽出）。
 *
 * 含四条线上路径：用户/系统/错误消息、assistant 流式回答、推理流、过程（工具）时间线，
 * 以及会话级迹线计数。共同点是"往消息区里画东西"，而状态全部集中在答案/推理/过程三组容器上。
 *
 * 拆分注意：这些函数在旧闭包里直接改 `answerEl` 之类的 `let`。拆出来后全部走 `state.*`，
 * 否则各模块会各持一份快照，`ensureAnswer()` 判空就会失效（回答会被续写进上一个回合的气泡）。
 */
import { renderMarkdown } from './render.js';
import { createBatcher } from './streamBatcher.js';
import { streamRenderIntervalMs } from './streamRenderPolicy.js';

export function createMessages(ctx) {
  const { el, fmtDuration, addMessage, scrollBottom, addCopyAction, dom, state } = ctx;
  const { btnTrajectory, trajBadge, trajCountEl, trajectoryEl, trajectoryBox, messagesEl } = dom;

  // -------------------------------------------------------------------------
  // 消息渲染
  // -------------------------------------------------------------------------

  /**
   * 系统消息（notice）。可带一个动作按钮 —— 批次 11-3 的「回滚本次改动」就挂在这里。
   *
   * 按钮点一次就**退休**（disabled，但不移除）：这条提示本身是审计记录，事后回看要能知道
   * "当时系统确实提示过可以回滚"；而同一个按钮还能连点第二次，就等于把回滚重复执行一遍。
   */
  function addSystem(text, action) {
    const node = el('div', 'message system', text);
    if (action && action.label && action.kind) {
      const btn = el('button', 'ok-btn notice-action', action.label);
      btn.type = 'button';
      btn.addEventListener('click', () => {
        btn.disabled = true;
        // 带上 sessionId：扩展侧据此校验「这条提示说的是不是当前会话」（见 webviewPanel）
        ctx.vscode.postMessage({ kind: action.kind, sessionId: action.sessionId });
      });
      node.appendChild(btn);
    }
    addMessage(node);
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
  function addUser(text, attachments, planMode) {
    const turn = el('div', 'turn user');
    turn.appendChild(roleMark('你', 'user'));
    const bubble = el('div', 'message user');
    bubble.innerHTML = renderMarkdown(text);
    turn.appendChild(bubble);
    const row = el('div', 'chips');
    // 计划模式也占一个 chip：事后回看时，"这条为什么先出计划"必须能一眼看出来，
    // 而开关状态本身只活在输入框上，滚动后早就看不见了。
    if (planMode) row.appendChild(el('span', 'chip chip-plan', '计划模式'));
    const chips = Array.isArray(attachments) ? attachments : [];
    for (const c of chips) {
      const label = typeof c === 'string' ? c : c && c.label;
      // 图片 chip 带 imageId：缩略图就在本地（发送时留存的预览），直接画出来。
      // 取不到预览（例如重放的历史消息）就退回文字 chip，不显示破图。
      const imageId = typeof c === 'object' && c ? c.imageId : undefined;
      const previewUrl = imageId ? state.sentImagePreviews.get(imageId) : undefined;
      if (previewUrl) {
        const box = el('div', 'chip chip-image');
        const pic = document.createElement('img');
        pic.src = previewUrl;
        pic.alt = String(label || '图片');
        pic.title = String(label || '图片');
        box.appendChild(pic);
        row.appendChild(box);
        continue;
      }
      if (label) row.appendChild(el('span', 'chip', String(label)));
    }
    if (row.childNodes.length) turn.appendChild(row);
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
    if (!state.answerBody) return;
    state.answerRenderedAt = Date.now();
    state.answerBody.innerHTML = renderMarkdown(state.answerRaw);
    scrollBottom();
  }

  /** 按体量节流地安排一次流式渲染：能渲就立刻渲，否则排一个尾随补渲。 */
  function scheduleAnswerRender() {
    if (!state.answerBody) return;
    const wait = streamRenderIntervalMs(state.answerRaw.length) - (Date.now() - state.answerRenderedAt);
    if (wait <= 0) {
      cancelAnswerRender();
      renderAnswerStream();
      return;
    }
    if (state.answerRenderTimer != null) return;
    state.answerRenderTimer = setTimeout(() => {
      state.answerRenderTimer = null;
      renderAnswerStream();
    }, wait);
  }

  function cancelAnswerRender() {
    if (state.answerRenderTimer != null) {
      clearTimeout(state.answerRenderTimer);
      state.answerRenderTimer = null;
    }
  }

  function ensureAnswer() {
    if (state.answerEl) return;
    state.answerEl = el('div', 'turn assistant');
    state.answerEl.appendChild(roleMark('dsh', 'agent'));
    state.answerBody = el('div', 'message assistant md streaming', '');
    state.answerEl.appendChild(state.answerBody);
    addMessage(state.answerEl);
    state.answerRaw = '';
    // 让首次增量立刻渲染（避免"前 80ms 屏幕还是空的"，也便于同步断言）
    state.answerRenderedAt = Date.now() - streamRenderIntervalMs(0);
    state.answerBatcher = createBatcher((text) => {
      state.answerRaw += text;
      scheduleAnswerRender();
    });
  }

  function appendAssistant(delta) {
    ensureAnswer();
    state.answerBatcher.append(delta);
  }

  // 流式期间按体量节流地渲染 Markdown；结束时再做一次完整定妆渲染。
  function finishAssistant() {
    if (state.answerBatcher) state.answerBatcher.flush();
    cancelAnswerRender();
    if (state.answerBody) {
      const raw = state.answerRaw;
      state.answerBody.classList.remove('streaming');
      state.answerBody.innerHTML = renderMarkdown(raw);
      addCopyAction(state.answerEl, raw);
      scrollBottom();
    }
    finishReasoning();
    stopActivityTimer();
    state.answerEl = null;
    state.answerBody = null;
    state.answerBatcher = null;
    state.answerRaw = '';
    state.answerRenderedAt = 0;
  }

  // ---- 推理流：默认折叠，只用一个计时标签提示「正在思考」，不挤占回答
  function ensureReasoning() {
    if (state.reasoningEl) return;
    const details = el('details', 'reasoning');
    const summary = el('summary', '');
    state.reasoningLabel = el('span', 'reasoning-label', '思考中…');
    summary.appendChild(state.reasoningLabel);
    state.reasoningBody = el('pre', 'reasoning-body', '');
    details.appendChild(summary);
    details.appendChild(state.reasoningBody);
    state.reasoningStartedAt = Date.now();
    state.reasoningTimer = setInterval(() => {
      if (state.reasoningLabel) {
        state.reasoningLabel.textContent = '思考中… ' + fmtDuration(Date.now() - state.reasoningStartedAt);
      }
    }, 1000);
    state.reasoningBatcher = createBatcher((text) => {
      state.reasoningBody.textContent += text;
      if (details.open) scrollBottom();
    });
    addMessage(details);
    state.reasoningEl = details;
  }

  function appendReasoning(delta) {
    ensureReasoning();
    state.reasoningBatcher.append(delta);
  }

  function finishReasoning() {
    if (state.reasoningBatcher) state.reasoningBatcher.flush();
    if (state.reasoningTimer) {
      clearInterval(state.reasoningTimer);
      state.reasoningTimer = null;
    }
    if (state.reasoningLabel) {
      const text = state.reasoningBody ? state.reasoningBody.textContent : '';
      state.reasoningLabel.textContent =
        '已思考 ' +
        fmtDuration(Math.max(1, Date.now() - state.reasoningStartedAt)) +
        (text ? '（点击展开）' : '');
    }
    state.reasoningEl = null;
    state.reasoningBody = null;
    state.reasoningLabel = null;
    state.reasoningBatcher = null;
  }

  // ---- 过程：把工具调用聚合成一条时间线，默认折叠，点开才看输入/输出
  //
  // 为什么默认折叠：工具调用属于"过程"，而回答才是用户要的结论。展开状态下列表会把结论
  // 一路挤出视野（实测一轮十来步就要滚好几屏），与"回答是主角"的层级正好相反。
  // 折叠后头部仍持续显示「N 步 · 耗时 · N 失败」，既有进度反馈，也不占版面。
  function ensureActivity() {
    if (state.activityEl) return;
    state.activityEl = el('section', 'activity collapsed');
    const head = el('div', 'activity-head');
    head.appendChild(el('span', 'chev', '▾'));
    head.appendChild(el('b', '', '过程'));
    state.activityMeta = el('span', 'activity-meta', '执行中…');
    head.appendChild(state.activityMeta);
    head.addEventListener('click', () => state.activityEl.classList.toggle('collapsed'));
    state.activityList = el('div', 'activity-list');
    state.activityEl.appendChild(head);
    state.activityEl.appendChild(state.activityList);
    state.activityStartedAt = Date.now();
    state.activitySteps = 0;
    state.activityFailures = 0;
    ensureActivityTimer();
    addMessage(state.activityEl);
  }

  function ensureActivityTimer() {
    if (state.activityTimer) return;
    state.activityTimer = setInterval(updateActivityMeta, 1000);
  }

  function stopActivityTimer() {
    if (state.activityTimer) {
      clearInterval(state.activityTimer);
      state.activityTimer = null;
    }
  }

  function updateActivityMeta() {
    if (!state.activityMeta) return;
    state.activityMeta.textContent =
      state.activitySteps +
      ' 步 · ' +
      fmtDuration(Date.now() - state.activityStartedAt) +
      (state.activityFailures ? ' · ' + state.activityFailures + ' 失败' : '');
    state.activityMeta.className = 'activity-meta' + (state.activityFailures ? ' err' : '');
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
    if (state.toolRows.has(tool)) return;
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
    state.activityList.appendChild(row);
    state.activitySteps += 1;
    updateActivityMeta();
    state.toolRows.set(tool, { row, line, body, dur, startedAt: Date.now() });
    scrollBottom();
  }

  function updateToolRow(tool, executed) {
    const entry = state.toolRows.get(tool);
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
      state.activityFailures += 1;
      entry.dur.classList.add('err');
      entry.line.appendChild(el('span', 'badge err', '失败'));
    }
    state.toolRows.delete(tool);
    updateActivityMeta();
    scrollBottom();
  }

  function resetTurn() {
    // 先收尾上一轮，且必须**放在第一行**。
    //
    // 正常路径下 `message.done` 已经调过 finishAssistant（它自身幂等，这里等于空操作）；
    // 真正的目标是异常路径：上一轮若既没收到 `message.done`、也没收到 `session.ended`
    // （daemon 在流式中崩溃、事件丢失、连接中断），`answerEl` 会一直挂着 ——
    // 随后 `ensureAnswer()` 直接 early-return，**新一轮的回答就被续写进上一轮的气泡里**。
    // 放在最前面，后面任何 early-return 都跳不过它。（finishReasoning/stopActivityTimer
    // 与 finishAssistant 内部重复是有意的：不依赖它的实现细节。）
    finishAssistant();
    finishReasoning();
    stopActivityTimer();
    state.activityEl = null;
    state.activityList = null;
    state.activityMeta = null;
    state.activitySteps = 0;
    state.activityFailures = 0;
    state.toolRows.clear();
  }

  // -------------------------------------------------------------------------
  // 迹线（会话级审计信息，独立于消息流）
  // -------------------------------------------------------------------------

  /**
   * P2-8：把轨迹的**结构化字段**压成行尾一段紧凑徽标。
   *
   * 为什么不把它们拼进 `detail`：`detail` 是给人读的原始记录（含命令原文），
   * 而徽标要能被扫读、能对齐、能按等级着色。两者混在一段文本里就都做不到了。
   * 无结构化字段时返回空串，调用方不追加节点 —— 旧记录（无这些字段）渲染结果与之前一致。
   */
  function trajMetaText(t) {
    const bits = [];
    if (t.ok === false) bits.push('⚠ 失败' + (t.errorKind ? '（' + t.errorKind + '）' : ''));
    if (typeof t.durationMs === 'number' && t.durationMs > 0) bits.push(fmtDuration(t.durationMs));
    if (t.tokens && typeof t.tokens.total === 'number') {
      bits.push((t.tokens.estimated ? '≈' : '') + t.tokens.total + ' tok');
    }
    return bits.join(' · ');
  }

  /**
   * 迹线是审计信息、不是对话内容，所以不主动弹面板打断阅读：
   * 只在顶栏按钮上亮出计数，用户想看时自己点开。
   */
  function addTrajectory(t) {
    state.trajCount += 1;
    btnTrajectory.hidden = false;
    trajBadge.textContent = String(state.trajCount);
    trajCountEl.textContent = state.trajCount + ' 步';
    const line = el('div', 'traj-line');
    line.appendChild(el('span', 'traj-step', '#' + t.step));
    line.appendChild(el('span', 'traj-kind', t.kind));
    line.appendChild(el('span', 'traj-detail', t.detail));
    const meta = trajMetaText(t);
    if (meta) {
      line.appendChild(el('span', 'traj-meta' + (t.ok === false ? ' is-fail' : ''), meta));
    }
    trajectoryEl.appendChild(line);
  }

  // -------------------------------------------------------------------------
  // 会话级清空（只负责"消息面"：消息区 / 迹线 / 工具行 / 三组流状态）
  // -------------------------------------------------------------------------

  /**
   * 清空消息区与随会话作废的流状态。挂起卡片归 cards 管，暂存图片归 composer 管 ——
   * 由事件桥 clearMessages() 按原顺序依次调用，避免任一处漏清。
   */
  function clearMessagesView() {
    messagesEl.textContent = '';
    ctx.syncEmptyState();
    trajectoryEl.textContent = '';
    trajectoryBox.hidden = true;
    state.trajCount = 0;
    trajCountEl.textContent = '';
    trajBadge.textContent = '';
    btnTrajectory.hidden = true;
    state.toolRows.clear();
    if (state.reasoningBatcher) state.reasoningBatcher.reset();
    if (state.answerBatcher) state.answerBatcher.reset();
    cancelAnswerRender();
    if (state.reasoningTimer) clearInterval(state.reasoningTimer);
    state.reasoningTimer = null;
    state.reasoningEl = null;
    state.reasoningBody = null;
    state.reasoningLabel = null;
    state.reasoningBatcher = null;
    state.answerEl = null;
    state.answerBody = null;
    state.answerBatcher = null;
    state.answerRaw = '';
    state.answerRenderedAt = 0;
    stopActivityTimer();
    state.activityEl = null;
    state.activityList = null;
    state.activityMeta = null;
    state.activitySteps = 0;
    state.activityFailures = 0;
  }

  return {
    addSystem,
    addError,
    addUser,
    addAssistantHtml,
    appendAssistant,
    appendReasoning,
    finishAssistant,
    finishReasoning,
    resetTurn,
    addToolRow,
    updateToolRow,
    addTrajectory,
    clearMessagesView,
  };
}
