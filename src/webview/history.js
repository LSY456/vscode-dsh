/**
 * 历史会话 / 覆盖面板 / 设置表单 / 信任白名单（批次 8 从 media/webview.js 抽出）。
 *
 * 这一组都是"侧滑面板里的内容"：历史列表、设置表单、迹线面板共用同一套开合逻辑
 * （`openSheet` / `closeSheets` 三者互斥）。归一处避免"开一个忘关另一个"这类漏改。
 *
 * 跨模块调用（回放历史要清空消息区、再逐条画消息）走 `ctx.api`。
 */
export function createHistory(ctx) {
  const { el, vscode, dom, api } = ctx;
  const {
    historyList,
    historyPanel,
    settingsPanel,
    trajectoryBox,
    settingsMsg,
    btnSettingsRestart,
    inpApiKey,
    inpModel,
    modelHintEl,
    inpBaseURL,
    inpProvider,
    inpPreset,
    inpMaxRounds,
    inpTemperature,
    trustListEl,
  } = dom;

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
    api.clearMessages();
    if (!rec || !Array.isArray(rec.messages)) return;
    api.setSessionTitle(rec.title);
    for (const m of rec.messages) {
      if (m.role === 'user') api.addUser(m.text);
      else if (m.role === 'assistant') api.addAssistantHtml(m.text);
      else api.addSystem(m.text);
    }
    ctx.scrollBottom(true);
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

  /**
   * 模型下拉：选项由扩展给出（唯一数据源，来源可能是在线列表 / 内置快照 / 当前配置项），
   * 这里只负责渲染，不猜模型名。
   *
   * 两条必须守住的行为：
   *  ① 打开面板时传 `selected`（= 当前配置值）；异步刷新推来的列表不带 `selected`
   *     → 保留用户此刻的选择，后台刷新不会把用户刚点的选项弹回上一个；
   *  ② 列表为空时**什么都不做** —— 宁可留着旧列表，也不要把字段清空（空值提交会改坏配置）。
   */
  function applyModelOptions(params) {
    const models = (params && params.models) || [];
    const prev = inpModel.value;
    const ids = [];
    // 先构建到游离 fragment 里，**最后**才提交到 DOM：
    // 空列表那条提前返回必须发生在"清空现有选项"之前，否则失败一次就变成空下拉。
    const frag = document.createDocumentFragment();
    for (const m of models) {
      const id = m && typeof m.id === 'string' ? m.id : '';
      if (!id || ids.indexOf(id) >= 0) continue; // 去重 + 挡脏数据
      ids.push(id);
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = (m && m.label) || id;
      frag.appendChild(opt);
    }
    if (ids.length === 0) return;
    inpModel.textContent = '';
    inpModel.appendChild(frag);
    const want = (params && params.selected) || prev;
    inpModel.value = ids.indexOf(want) >= 0 ? want : ids[0];
    modelHintEl.textContent = (params && params.modelsHint) || '';
  }

  /**
   * 下拉里没有该值就先补一个选项。
   *
   * 预设这类字段在面板里是固定单选，但配置文件里可能存着历史值；若不补选项，
   * `<select>.value = 'x'` 会落成空串，提交时把用户存过的值**悄悄改写成缺省**。
   */
  function ensureOption(sel, value) {
    if (!sel || !value) return;
    for (const opt of sel.options) {
      if (opt.value === value) return;
    }
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = value;
    sel.appendChild(opt);
  }

  function fillSettings(params) {
    const cfg = (params && params.config) || {};
    inpApiKey.placeholder = params && params.hasApiKey ? '已设置（留空不修改）' : '未设置';
    // 顺序要紧：先建 option 再设值 —— <select> 的 value 只在对应 option 存在时才生效
    applyModelOptions({
      models: params && params.models,
      modelsHint: params && params.modelsHint,
      selected: cfg.model,
    });
    inpBaseURL.value = cfg.baseURL || '';
    inpProvider.value = cfg.provider || 'auto';
    // 预设是下拉（固定单选）—— 先把配置值保成选项，再设值，避免落成空串后反手改写配置
    const preset = cfg.preset || 'default';
    ensureOption(inpPreset, preset);
    inpPreset.value = preset;
    // 数值字段：缺失时留空，**不要写 0** —— 输入框显示 "0" 会让用户以为上限就是 0。
    inpMaxRounds.value = cfg.maxToolRounds == null ? '' : String(cfg.maxToolRounds);
    // 采样温度：null / undefined = 用户从没配过 → 留空。不要写 0.2 或 0：温度 0 是**合法值**，
    // 显示成具体数字会让"没配"和"配成了这个数"混为一谈。
    inpTemperature.value = cfg.temperature == null ? '' : String(cfg.temperature);
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

  return {
    renderHistory,
    renderHistoryMessages,
    openSheet,
    closeSheets,
    applyModelOptions,
    fillSettings,
    renderTrust,
  };
}
