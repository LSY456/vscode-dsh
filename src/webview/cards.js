/**
 * 挂起卡片：审批 / 计划 / 补丁 + 输入框上方的待办条（批次 8 从 media/webview.js 抽出）。
 *
 * 为什么这三类卡在同一模块：它们共享同一套"决策即折叠、绝不删除（`attachCollapse` /
 * `retireActions`）"的审计语义，也共享同一条待办条投影（`updatePendingBar` 同时读三类挂起项，
 * 倒计时取三者中最早到期）。拆散只会让这段共享逻辑复制三份。
 */
import { renderMarkdown } from './render.js';

export function createCards(ctx) {
  const { el, addMessage, scrollBottom, vscode, dom, state } = ctx;
  const { pendingBar, pendingLabel, pendingActions } = dom;

  // -------------------------------------------------------------------------
  // 折叠 / 回收（三类卡共用）
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

  // -------------------------------------------------------------------------
  // 审批卡（Human-in-the-Loop）
  // -------------------------------------------------------------------------

  function stopApprovalTimer(id) {
    const t = state.approvalTimers.get(id);
    if (t) {
      clearInterval(t);
      state.approvalTimers.delete(id);
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
    const entry = state.approvals.get(approvalId);
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
    state.approvals.set(p.approvalId, entry);

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
      state.approvalTimers.set(p.approvalId, setInterval(tick, 1000));
      tick();
    }
    updatePendingBar();
  }

  function expireApproval(approvalId) {
    stopApprovalTimer(approvalId);
    const entry = state.approvals.get(approvalId);
    if (entry && !entry.decided) markApprovalDecided(entry, 'expired');
    updatePendingBar();
  }

  function onApprovalResponded(approvalId) {
    // daemon 已受理：卡片作为历史保留，只置为不可再操作
    stopApprovalTimer(approvalId);
    const entry = state.approvals.get(approvalId);
    if (entry && !entry.decided) markApprovalDecided(entry, 'accepted');
    updatePendingBar();
  }

  // -------------------------------------------------------------------------
  // 计划卡（P2-7：先出计划、批准后才执行）
  // -------------------------------------------------------------------------

  function stopPlanTimer(id) {
    const t = state.planTimers.get(id);
    if (t) {
      clearInterval(t);
      state.planTimers.delete(id);
    }
  }

  function markPlanDecided(entry, outcome) {
    entry.decided = true;
    entry.card.classList.add('decided');
    retireActions(entry);
    // 补充意见输入框在决策后必须收掉：留一个还能打字、但内容再也送不出去的框，
    // 用户会以为自己的意见已经生效了。
    if (entry.noteRow) entry.noteRow.hidden = true;
    if (entry.countdown) entry.countdown.textContent = '';
    if (entry.badge) {
      if (outcome === 'rejected') {
        entry.badge.className = 'badge err';
        entry.badge.textContent = '不同意';
      } else if (outcome === 'expired') {
        entry.badge.className = 'badge err';
        entry.badge.textContent = '已过期';
      } else {
        entry.badge.className = 'badge ok';
        entry.badge.textContent = '已批准';
      }
    }
    collapseEntry(entry);
  }

  function decidePlan(planId, approved) {
    const entry = state.plans.get(planId);
    if (entry && entry.decided) return;
    // 先取意见再置决策态：markPlanDecided 会把输入框藏起来，顺序反了就永远读到空串
    const note = entry && entry.noteEl ? entry.noteEl.value.trim() : '';
    if (entry) markPlanDecided(entry, approved ? 'approved' : 'rejected');
    vscode.postMessage({
      kind: 'plan.respond',
      planId,
      approved,
      ...(note ? { note } : {}),
    });
    stopPlanTimer(planId);
    updatePendingBar();
  }

  function addPlanCard(p) {
    const card = el('div', 'card plan');
    const title = el('div', 'card-title');
    // 标题写**主题**、徽标写**结论**（与「⚠ 工具审批」「📝 文件补丁」同一约定）：
    // 标题若写成"计划待批准"，决策后就会和徽标自相矛盾（"待批准"配"不同意"）。
    title.appendChild(el('b', '', '📋 计划方案'));
    const badge = el('span', 'badge warn', '待批准');
    title.appendChild(badge);
    card.appendChild(title);

    // 正文单独成块：决策后整块折叠，标题行（含结论徽标）保持可见
    const body = el('div', 'card-body');
    const md = el('div', 'card-md md');
    md.innerHTML = renderMarkdown(p.plan || '');
    body.appendChild(md);

    // 补充意见：批准时带上"但请改一处"，执行阶段以它为准（见 planApprovedInstruction）
    const noteRow = el('label', 'card-note');
    noteRow.appendChild(el('span', 'card-note-label', '补充意见（可选）'));
    const noteEl = document.createElement('textarea');
    noteEl.rows = 2;
    noteEl.placeholder = '例如：第 2 步不要动 X 文件';
    noteRow.appendChild(noteEl);
    body.appendChild(noteRow);

    const countdown = el('div', 'countdown', '');
    const actions = el('div', 'card-actions');
    const btnReject = el('button', 'danger', '不同意');
    const btnApprove = el('button', 'ok-btn', '批准并执行');
    btnReject.type = btnApprove.type = 'button';
    btnReject.addEventListener('click', () => decidePlan(p.planId, false));
    btnApprove.addEventListener('click', () => decidePlan(p.planId, true));
    actions.append(btnReject, btnApprove);

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
      noteRow,
      noteEl,
      actions,
      buttons: [btnReject, btnApprove],
      collapse,
      decided: false,
    };
    state.plans.set(p.planId, entry);

    if (p.expiresAt) {
      const tick = () => {
        const remain = Math.max(0, Math.ceil((p.expiresAt - Date.now()) / 1000));
        if (remain <= 0) {
          countdown.textContent = '⏱ 已过期（按不同意处理）';
          expirePlan(p.planId);
          return;
        }
        countdown.textContent = '⏱ 剩余 ' + remain + 's 未响应将按不同意处理';
      };
      state.planTimers.set(p.planId, setInterval(tick, 1000));
      tick();
    }
    updatePendingBar();
  }

  function expirePlan(planId) {
    stopPlanTimer(planId);
    const entry = state.plans.get(planId);
    if (entry && !entry.decided) markPlanDecided(entry, 'expired');
    updatePendingBar();
  }

  function openPlans() {
    return [...state.plans.values()].filter((e) => !e.decided);
  }

  // -------------------------------------------------------------------------
  // 文件补丁卡（Native Diff 预览入口）
  // -------------------------------------------------------------------------

  function decidePatch(patchId, action) {
    const entry = state.patches.get(patchId);
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
      state.patchTimers.set(p.patchId, setInterval(tick, 1000));
      tick();
    }
    body.appendChild(actions);
    card.appendChild(body);
    const collapse = attachCollapse(card, title);
    addMessage(card);

    state.patches.set(p.patchId, {
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
    const t = state.patchTimers.get(patchId);
    if (t) {
      clearInterval(t);
      state.patchTimers.delete(patchId);
    }
  }

  /** 补丁过期：按拒绝处理（daemon 也会回 file.patch.result，届时再落到最终状态）。 */
  function expirePatch(patchId) {
    stopPatchTimer(patchId);
    const entry = state.patches.get(patchId);
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
    const entry = state.patches.get(result.patchId);
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
      state.patches.delete(result.patchId);
    }
    updatePendingBar();
    scrollBottom();
  }

  // -------------------------------------------------------------------------
  // 待办条：挂起项投影到输入框上方，滚到哪儿都不会漏掉（60s 过期倒计时同步显示）
  // -------------------------------------------------------------------------

  function openApprovals() {
    return [...state.approvals.values()].filter((e) => !e.decided);
  }

  function openPatches() {
    return [...state.patches.values()].filter((e) => !e.responded);
  }

  function stopPendingTicker() {
    if (state.pendingTicker) {
      clearInterval(state.pendingTicker);
      state.pendingTicker = null;
    }
  }

  function tickPending() {
    if (!state.pendingCountdownEl) return;
    const expiresAt = earliestExpiry();
    if (!expiresAt) {
      state.pendingCountdownEl.textContent = '';
      return;
    }
    const remain = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
    state.pendingCountdownEl.textContent = remain > 0 ? '⏱ ' + remain + 's' : '⏱ 已过期';
  }

  /** 待办条倒计时取所有挂起项里最早到期的一个（计划 / 审批 / 补丁同权）。 */
  function earliestExpiry() {
    const values = [...openPlans(), ...openApprovals(), ...openPatches()]
      .map((e) => e.data.expiresAt)
      .filter((v) => typeof v === 'number');
    return values.length ? Math.min(...values) : undefined;
  }

  function ensurePendingTicker() {
    if (state.pendingTicker) return;
    state.pendingTicker = setInterval(tickPending, 1000);
  }

  function updatePendingBar() {
    const openA = openApprovals();
    const openP = openPatches();
    const openPl = openPlans();
    const total = openA.length + openP.length + openPl.length;
    pendingLabel.textContent = '';
    pendingActions.textContent = '';
    state.pendingCountdownEl = null;

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

    // 计划排在最先：它不决定"某个动作做不做"，而决定"整轮做不做" ——
    // 别的挂起项在计划被批准前根本不会产生，把它压在后面等于让用户猜先点哪个。
    if (openPl.length) {
      const id = openPl[0].data.planId;
      pendingLabel.appendChild(el('b', '', '等待你批准计划'));
      if (more) pendingLabel.appendChild(el('small', '', more));
      pendingActions.append(
        mkButton('不同意', 'danger', () => decidePlan(id, false)),
        mkButton('批准并执行', 'primary', () => decidePlan(id, true))
      );
    } else if (openA.length) {
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
      state.pendingCountdownEl = el('span', 'badge warn', '');
      pendingLabel.appendChild(state.pendingCountdownEl);
    }
    ensurePendingTicker();
    tickPending();
  }

  /**
   * 清空全部挂起卡片与计时器，并隐藏待办条。会话级重置时由事件桥调用。
   * 顺序：先清 map 再清 timer，最后 updatePendingBar —— 与旧实现一致（此时 map 已空，必然会隐藏）。
   */
  function clearCards() {
    state.approvals.clear();
    state.patches.clear();
    state.plans.clear();
    for (const t of state.approvalTimers.values()) clearInterval(t);
    state.approvalTimers.clear();
    for (const t of state.patchTimers.values()) clearInterval(t);
    state.patchTimers.clear();
    for (const t of state.planTimers.values()) clearInterval(t);
    state.planTimers.clear();
    stopPendingTicker();
    state.pendingCountdownEl = null;
    updatePendingBar();
  }

  return {
    addApprovalCard,
    expireApproval,
    onApprovalResponded,
    addPlanCard,
    expirePlan,
    addPatchCard,
    updatePatchCard,
    clearCards,
  };
}
