/**
 * 扩展 → webview 的事件分发与会话级重置（批次 8 从 media/webview.js 抽出）。
 *
 * 这里是"唯一入口"：所有来自扩展的 `message` 都经 `installEventBridge` 落到 `handleEvent`。
 * 会话级重置（clearMessages / resetForSession / restorePending）也放在这里 —— 它需要按顺序
 * 调用消息面、卡片、输入区三个模块的清理，是天然的"编排点"，散到各模块只会互相 import。
 */
export function createEvents(ctx) {
  const { state, dom, api, reportDiag } = ctx;
  const { btnJump } = dom;

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
  function clearMessages() {
    // 顺序与旧实现一致：先清消息面，再清挂起卡片（清完卡片 updatePendingBar 才会隐藏待办条），
    // 最后收掉输入区与本轮状态。
    api.clearMessagesView();
    api.clearCards();
    api.setSession('');
    api.setSessionTitle('');
    btnJump.hidden = true;
    state.pinned = true;
    api.setRunning(false);
  }

  function resetForSession(sessionId, reason) {
    clearMessages();
    // 暂存与已发缩略图都属于"这个会话的现场"，换会话就一并作废
    api.clearComposer();
    api.setSession(sessionId);
    // 顺带换一组起点：同池按会话号轮换（见 src/webview/suggestions.js）
    api.renderSuggestions(sessionId);
    if (reason === 'switch') api.addSystem('已切换到该会话，可继续对话');
    else if (reason === 'replay') api.addSystem('连接已恢复，正在重放会话内容…');
  }

  /** surface 重建后恢复挂起项（计划 / 审批 / 补丁卡与待办条） */
  function restorePending(pending) {
    if (!pending) return;
    for (const p of pending.plans || []) api.addPlanCard(p);
    for (const p of pending.approvals || []) api.addApprovalCard(p);
    for (const p of pending.patches || []) api.addPatchCard(p);
  }

  // -------------------------------------------------------------------------
  // 事件分发（extension -> webview）
  // -------------------------------------------------------------------------

  function handleEvent(method, params) {
    switch (method) {
      case 'user.message':
        api.commitStagedImages();
        api.resetTurn();
        api.addUser(params.text, params.attachments, params.planMode);
        break;
      case 'session.started':
        api.setRunning(true);
        api.setSession(params.sessionId);
        api.setSessionTitle(params.title);
        api.addSystem('会话开始' + (params.title ? '：' + params.title : ''));
        break;
      case 'reasoning.delta':
        api.appendReasoning(params.delta);
        break;
      case 'message.delta':
        api.appendAssistant(params.delta);
        break;
      case 'message.done':
        api.finishAssistant();
        break;
      case 'tool.started':
        api.addToolRow(params.tool, params.input);
        break;
      case 'tool.executed':
        api.updateToolRow(params.tool, params);
        break;
      case 'approval.request':
        api.addApprovalCard(params);
        break;
      case 'approval.expired':
        api.expireApproval(params.approvalId);
        break;
      case 'approval.responded':
        api.onApprovalResponded(params.approvalId);
        break;
      case 'plan.request':
        api.addPlanCard(params);
        break;
      case 'plan.expired':
        api.expirePlan(params.planId);
        break;
      case 'file.patch.pending':
        api.addPatchCard(params);
        break;
      case 'file.patch.result':
        api.updatePatchCard(params);
        break;
      case 'trajectory.record':
        api.addTrajectory(params);
        break;
      case 'session.ended': {
        api.setRunning(false);
        api.finishAssistant();
        // reason 是协议里的英文枚举，直接展示等于把 "error" 这种内部字眼丢给用户；
        // 而"会话为什么结束"恰恰是此刻最该看懂的信息——早先只写 completed/error，
        // 用户既不知道发生了什么，也不知道停在哪一步（本次修复的原始反馈之一）。
        const endedLabels = { completed: '已完成', canceled: '已取消', error: '出错中止（详见上方错误）' };
        api.addSystem('会话结束：' + (endedLabels[params.reason] || params.reason || '已完成'));
        break;
      }
      case 'history.loaded':
        api.renderHistoryMessages(params);
        break;
      case 'agent.info':
        // 扩展本地事件（非 daemon 协议）：每次握手后同步当前 Agent 实现
        api.setAgentInfo(params);
        break;
      case 'trust.info':
        // 扩展本地事件：工作区信任状态（受限模式下 daemon 不启动，拿不到任何握手事件，
        // 所以撤下「受限模式」横幅只能靠这条）
        api.setTrustGate(params);
        break;
      case 'notice':
        api.addSystem(params.text);
        break;
      case 'settings.loaded':
        api.fillSettings(params);
        break;
      case 'settings.models':
        // 后台刷新回来的在线模型列表：只换选项，不动用户此刻的选择（见 applyModelOptions）
        api.applyModelOptions(params);
        break;
      case 'balance.info':
        // 扩展本地事件：账户余额（状态行）。不可用时隐藏整块 chip
        api.setBalance(params);
        break;
      case 'settings.applied':
        dom.settingsMsg.textContent = '已保存，重启 daemon 后生效。';
        dom.btnSettingsRestart.hidden = false;
        dom.inpApiKey.value = '';
        break;
      case 'trust.loaded':
        api.renderTrust(params && params.rules);
        break;
      case 'daemon.restarted':
        dom.btnSettingsRestart.disabled = false;
        dom.settingsMsg.textContent = 'daemon 已重启。';
        break;
      case 'error':
        api.setRunning(false);
        api.addError(params.message);
        break;
      default:
        // 未知事件不静默：协议新增了事件而前端没跟上时，这条是唯一的线索（debug 级，不打扰用户）
        reportDiag('debug', method, '前端未实现的协议事件');
        break;
    }
  }

  function installEventBridge() {
    window.addEventListener('message', (e) => {
      const msg = e.data || {};
      switch (msg.kind) {
        case 'status':
          api.setStatus(msg.status, msg.detail);
          break;
        case 'init':
          api.setSession(msg.state && msg.state.sessionId);
          api.setAgentInfo(msg.state);
          api.setTrustGate(msg.state && msg.state.trust);
          if (msg.state && msg.state.connected) api.setStatus('connected', '');
          api.renderHistory(msg.state && msg.state.history);
          restorePending(msg.state && msg.state.pending);
          break;
        case 'session.reset':
          resetForSession(msg.sessionId, msg.reason);
          break;
        case 'event':
          // 单条事件抛错**绝不能静默吞掉**：此前异常直接冒泡出 message 回调，被浏览器丢掉，
          // 表现是"某条事件之后界面就没反应了"——协议漂移被掩盖成"UI 坏了"，无从归因。
          // 这里兜住并把方法名 + 错误回报扩展侧（落 OutputChannel），排障才有线索。
          try {
            handleEvent(msg.method, msg.params);
          } catch (err) {
            reportDiag('warn', msg.method, err && err.message ? String(err.message) : String(err));
          }
          break;
        default:
          break;
      }
    });
  }

  return { handleEvent, installEventBridge, clearMessages, resetForSession, restorePending };
}
