/* dsh Agent Webview UI（vanilla JS，无框架依赖）。
 * 经 esbuild 打包：本文件为 bundle 入口，import 的各模块会内联其中（外链为零，符合 CSP）。
 *
 * 本文件是拆分（批次 8 / P1-12）后的**薄入口**：只做三件事 ——
 *   ① 建立共享壳（panelCore：DOM 引用 + 可变 state + 原语）；
 *   ② 组装各特性模块（statusBar / messages / cards / history / composer / events）；
 *   ③ 全局 DOM 接线 + 启动。
 * 业务逻辑都在 src/webview/*.js 里，见各模块顶部的说明。
 *
 * UI 约定（与 media/webview.css 配套）：
 *  - 回答是主角：assistant 文本不做卡片包装，过程（推理 / 工具）折叠进「过程」时间线；
 *  - 挂起项（审批 / 补丁）除了留在消息流里，还投影到输入框上方的待办条，永远不会被滚出视野；
 *  - 滚动锁定：用户往上翻看历史时不再被流式输出硬拽到底部，改为浮出「有新内容」按钮；
 *  - 挂起项 60s 过期，卡片与待办条都显示倒计时。
 */
import { createPanel } from '../src/webview/panelCore.js';
import { createStatusBar } from '../src/webview/statusBar.js';
import { createMessages } from '../src/webview/messages.js';
import { createCards } from '../src/webview/cards.js';
import { createHistory } from '../src/webview/history.js';
import { createComposer } from '../src/webview/composer.js';
import { createEvents } from '../src/webview/events.js';

(function () {
  'use strict';

  const ctx = createPanel();
  const api = ctx.api;

  // 各模块把公开函数挂到同一个 api 对象上。装配顺序不重要：模块之间只通过 ctx.api
  // 在**回调/启动阶段**互相调用，那时 api 已填满（闭包持有的是同一引用）。
  Object.assign(api, createStatusBar(ctx));
  Object.assign(api, createMessages(ctx));
  Object.assign(api, createCards(ctx));
  Object.assign(api, createHistory(ctx));
  Object.assign(api, createComposer(ctx));
  Object.assign(api, createEvents(ctx));

  const { vscode, dom } = ctx;
  const {
    inputEl,
    composerBox,
    btnAttach,
    fileInput,
    btnSend,
    btnCancel,
    btnNew,
    btnHistory,
    historyPanel,
    btnHistoryClose,
    btnSettings,
    settingsPanel,
    btnSettingsClose,
    btnTrajectory,
    trajectoryBox,
    btnTrajectoryClose,
    btnStateAction,
    balanceEl,
    btnSettingsRestart,
    settingsForm,
    inpApiKey,
    inpModel,
    inpBaseURL,
    inpProvider,
    inpPreset,
    inpMaxRounds,
    inpMaxContext,
    inpTemperature,
    inpMaxTokens,
    settingsMsg,
    btnTrustClear,
    btnPlanMode,
    suggestEl,
  } = dom;

  // -------------------------------------------------------------------------
  // 全局 DOM 接线（webview -> extension）
  // -------------------------------------------------------------------------

  btnSend.addEventListener('click', api.send);
  btnCancel.addEventListener('click', api.cancel);

  // ---- 图片输入（P2-4）：粘贴 / 拖放 / 选择文件
  inputEl.addEventListener('paste', (e) => {
    const files = api.imageFilesFrom(e.clipboardData);
    // 有图才处理；纯文本粘贴**不 preventDefault**，让浏览器照常把文字贴进去
    if (files.length) void api.stageImageFiles(files);
  });

  if (composerBox) {
    composerBox.addEventListener('dragover', (e) => {
      if (api.imageFilesFrom(e.dataTransfer).length === 0) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      composerBox.classList.add('drop-target');
    });
    composerBox.addEventListener('dragleave', () => composerBox.classList.remove('drop-target'));
    composerBox.addEventListener('drop', (e) => {
      const files = api.imageFilesFrom(e.dataTransfer);
      composerBox.classList.remove('drop-target');
      if (!files.length) return;
      e.preventDefault();
      void api.stageImageFiles(files);
    });
  }

  if (btnAttach && fileInput) {
    btnAttach.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const files = Array.from(fileInput.files || []);
      // 清空 value：否则连着选同一个文件不会触发 change
      fileInput.value = '';
      if (files.length) void api.stageImageFiles(files);
    });
  }
  btnNew.addEventListener('click', () => {
    vscode.postMessage({ kind: 'session.new' });
  });
  btnHistory.addEventListener('click', () => {
    if (historyPanel.hidden) api.openSheet('history');
    else api.closeSheets();
  });
  btnHistoryClose.addEventListener('click', api.closeSheets);
  btnSettings.addEventListener('click', () => {
    if (settingsPanel.hidden) api.openSheet('settings');
    else api.closeSheets();
  });
  btnSettingsClose.addEventListener('click', api.closeSheets);
  // 迹线：按需打开（不主动弹面板打断阅读），关闭与其它覆盖面板同一套逻辑
  btnTrajectory.addEventListener('click', () => {
    if (trajectoryBox.hidden) api.openSheet('trajectory');
    else api.closeSheets();
  });
  btnTrajectoryClose.addEventListener('click', api.closeSheets);
  // 演示模式横幅 → 一键进入模型配置（配好 Key 并重启 daemon 后横幅自动撤下）
  // 状态横幅的动作按钮：受限模式去信任工作区，演示模式去配置模型。
  // 用 bannerAction 这一个出口派发 —— 横幅是同一块 UI，动作却由当前状态决定。
  btnStateAction.addEventListener('click', () => {
    if (ctx.state.bannerAction === 'trust') vscode.postMessage({ kind: 'trust.manage' });
    else if (ctx.state.bannerAction === 'settings') api.openSheet('settings');
  });
  // 余额 chip：点了就立刻重取（自动刷新的时机与节流见 webviewPanel.refreshBalance）
  balanceEl.addEventListener('click', () => vscode.postMessage({ kind: 'balance.refresh' }));
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
    // 数值字段：**留空 = 不修改**（与 apiKey 同理）。不要用 Number('')（=0）提交，
    // 那会把"没填"变成"把上限设成 0"；非数字同样按未填写处理，交给扩展侧的缺省。
    const numOrUndefined = (raw) => {
      const text = String(raw == null ? '' : raw).trim();
      if (!text) return undefined;
      const n = Number(text);
      return Number.isFinite(n) ? n : undefined;
    };
    const maxToolRounds = numOrUndefined(inpMaxRounds.value);
    const maxContextTokens = numOrUndefined(inpMaxContext.value);
    const temperature = numOrUndefined(inpTemperature.value);
    const maxTokens = numOrUndefined(inpMaxTokens.value);
    // apiKey 留空表示不修改（不上报空串，避免误删已存凭据）；
    // 模型名同理：下拉还没填充/异常为空时，宁可什么都不提交，也不要把已配好的模型名清空。
    vscode.postMessage({
      kind: 'settings.apply',
      settings: {
        ...(apiKey ? { apiKey } : {}),
        ...(model ? { model } : {}),
        baseURL,
        provider,
        preset,
        ...(maxToolRounds !== undefined ? { maxToolRounds } : {}),
        ...(maxContextTokens !== undefined ? { maxContextTokens } : {}),
        ...(temperature !== undefined ? { temperature } : {}),
        ...(maxTokens !== undefined ? { maxTokens } : {}),
      },
    });
    settingsMsg.textContent = '保存中…';
  });
  btnTrustClear.addEventListener('click', () => {
    vscode.postMessage({ kind: 'trust.clear' });
    api.renderTrust([]); // 乐观清空；扩展回传 trust.loaded 再同步
  });

  inputEl.addEventListener('input', api.autosizeInput);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      api.send();
    }
  });

  // 计划开关（P2-7）：切换后保持到手动关掉 —— 它是"这一次会话想怎么干活"的模式，
  // 而刷新/重连后从 input 里消失会让用户以为设置丢了，所以初始化时显式写一次文案。
  if (btnPlanMode) {
    btnPlanMode.addEventListener('click', () => api.setPlanMode(!ctx.state.planModeEnabled));
    api.setPlanMode(false);
  }

  // Esc：优先关闭覆盖面板，其次停止正在进行的会话
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!historyPanel.hidden || !settingsPanel.hidden || !trajectoryBox.hidden) {
      api.closeSheets();
      return;
    }
    if (ctx.state.running) api.cancel();
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
      api.autosizeInput();
      inputEl.focus();
    });
  }

  // -------------------------------------------------------------------------
  // 启动
  // -------------------------------------------------------------------------

  // 首屏也要有一组起点（此时还没有会话号，用空 seed 的确定性结果）
  api.renderSuggestions('');

  api.autosizeInput();

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

  // 事件桥：把扩展推来的消息接到分发器上
  api.installEventBridge();

  // 通知扩展：面板已就绪
  vscode.postMessage({ kind: 'ready' });
})();
