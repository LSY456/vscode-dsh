/**
 * dsh VSCode 扩展入口。
 *
 * 组装：
 *  - DaemonManager：daemon 进程生命周期 + WebSocket 连接/握手/重连
 *  - DshDiffManager：原生 Diff 预览与补丁审批
 *  - WebviewPanelHost：对话 / 推理流 / 工具卡 / 审批卡 UI
 *  - 命令：dsh.openPanel / dsh.sendSelection / dsh.daemon.restart / dsh.daemon.status
 */
import * as vscode from 'vscode';
import { ConfigAccessor } from './configAccessor';
import { captureContext } from './contextCapture';
import { DaemonManager, DaemonStatus } from './daemonManager';
import { DshDiffManager } from './diffProvider';
import { DirtyTracker } from './dirtyTracker';
import { logger } from './logger';
import { daemonStateLabel } from './statusLabel';
import { openTrustManagement } from './trustCommands';
import { WebviewPanelHost } from './webviewPanel';
import { resolveTrustGate } from './workspaceTrust';

const STATUS_ICONS: Record<DaemonStatus, string> = {
  connected: '$(circle-filled)',
  connecting: '$(sync~spin)',
  starting: '$(sync~spin)',
  stopped: '$(circle-outline)',
  error: '$(error)',
  disabled: '$(circle-outline)',
  // 受限模式不是故障，而是"缺一个前置条件"：用锁形图标 + 警示色，并把点击动作指向信任入口
  restricted: '$(lock)',
};

let activeDaemon: DaemonManager | undefined;

/** 集成测试钩子：@vscode/test-electron 经 getExtension().exports 获取，运行时不改变产品行为。 */
export interface DshApi {
  daemon: DaemonManager;
  diff: DshDiffManager;
  panel: WebviewPanelHost;
}

export function activate(context: vscode.ExtensionContext): DshApi {
  logger.init(context);
  logger.info('vscode-dsh 激活');

  // apiKey 安全化（A4）：SecretStorage 优先、旧明文自动回迁清除
  const configAccessor = new ConfigAccessor(
    {
      get: (k) => context.secrets.get(k),
      store: (k, v) => context.secrets.store(k, v),
      delete: (k) => context.secrets.delete(k),
    },
    {
      get: <T,>(k: string, d: T): T => vscode.workspace.getConfiguration('dsh').get<T>(k, d),
      update: (k, v) =>
        Promise.resolve(
          vscode.workspace.getConfiguration('dsh').update(k, v, vscode.ConfigurationTarget.Global)
        ),
    }
  );

  const daemon = new DaemonManager({
    extensionPath: context.extensionPath,
    configAccessor,
    // P0-1（安全）：未受信任的工作区里**不拉起任何子进程**。
    // 唯一的拉起入口是 DaemonManager.start()（restart 也走它），所以命令 / 状态栏 /
    // 面板「重启 daemon」/ 断线重连都被同一道门覆盖，不存在绕行路径。
    isTrusted: () => vscode.workspace.isTrusted,
  });
  activeDaemon = daemon;
  const diff = new DshDiffManager(() => daemon.client);
  // P0-1：脏文档跟随——把编辑器里未保存的缓冲区内容同步给 daemon，
  // 使 Agent 读到的是"用户此刻看到的内容"，而不是过期的磁盘版本
  const dirty = new DirtyTracker({ getClient: () => daemon.client });
  const panel = new WebviewPanelHost(context, daemon, diff, configAccessor, dirty);
  context.subscriptions.push(dirty);
  // 侧边栏常驻入口（活动栏 dsh 图标 -> Agent 视图）
  panel.register(context);

  // ---- 状态栏
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = 'dsh.openPanel';
  statusBar.text = '$(hubot) dsh: 启动中';

  /**
   * 受限模式在状态栏上的呈现：文案给**动作**（而不是把 `restricted` 这个内部枚举丢给用户），
   * 颜色给警示，点击直接进信任流程。已信任时只回收颜色与命令，文本交给 onStatus 维护。
   */
  function applyTrustAppearance(): void {
    const gate = resolveTrustGate(vscode.workspace.isTrusted);
    if (!gate.blocked) {
      statusBar.backgroundColor = undefined;
      statusBar.command = 'dsh.openPanel';
      return;
    }
    statusBar.text = '$(lock) dsh: 需要信任此工作区';
    statusBar.tooltip = `dsh ${gate.statusLabel}\n${gate.statusDetail}`;
    statusBar.command = 'dsh.trustWorkspace';
    statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  }

  daemon.onStatus((info) => {
    // 正文只给用户看得懂的文案（旧实现在界面上直接显示 `dsh: connected` 这类内部枚举）；
    // 原始枚举留在 tooltip 里，排障时仍可看到
    statusBar.text = `${STATUS_ICONS[info.status] ?? '$(circle-outline)'} dsh: ${daemonStateLabel(info.status)}`;
    statusBar.tooltip = `dsh daemon\n状态: ${daemonStateLabel(info.status)}（${info.status}）\n详情: ${info.detail}`;
    applyTrustAppearance();
    statusBar.show();
  });

  // ---- 命令
  context.subscriptions.push(
    vscode.commands.registerCommand('dsh.openPanel', () => {
      void panel.reveal();
    }),
    vscode.commands.registerCommand('dsh.openEditor', () => {
      panel.createOrShowEditorPanel();
    }),
    vscode.commands.registerCommand('dsh.newSession', async () => {
      try {
        await panel.newSession();
      } catch (err) {
        void vscode.window.showErrorMessage(
          `新建会话失败: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }),
    vscode.commands.registerCommand('dsh.sendSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      let prompt = '请分析当前文件并给出建议。';
      if (editor) {
        const selection = editor.selection;
        if (!selection.isEmpty) {
          const selected = editor.document.getText(selection);
          prompt = `请分析以下选中代码（${editor.document.languageId}）：\n\n${selected}`;
        } else {
          const doc = editor.document;
          prompt = `请分析当前文件 ${doc.uri.fsPath}（${doc.languageId}），并指出潜在问题与改进建议。`;
        }
      }
      await panel.sendPrompt(prompt);
    }),
    vscode.commands.registerCommand('dsh.daemon.restart', async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'dsh: 重启 daemon…' },
        async () => {
          await daemon.restart();
        }
      );
      const s = daemon.getStatus();
      if (s.status === 'connected') {
        void vscode.window.showInformationMessage(`dsh daemon 已连接: ${s.detail}`);
      } else {
        void vscode.window.showErrorMessage(`dsh daemon ${daemonStateLabel(s.status)}: ${s.detail}`);
      }
    }),
    vscode.commands.registerCommand('dsh.daemon.status', () => {
      const s = daemon.getStatus();
      void vscode.window.showInformationMessage(`dsh daemon: ${daemonStateLabel(s.status)}\n${s.detail}`);
    }),
    // 受限模式的唯一出口：状态栏 / 面板横幅 / 命令面板三处都走它。
    // package.json 里带 enablement: !isWorkspaceTrusted —— 已信任时不该出现在命令面板。
    vscode.commands.registerCommand('dsh.trustWorkspace', () => openTrustManagement()),
    statusBar
  );

  // ---- 调试辅助：在输出面板打印当前捕获的上下文
  // P2-3：OutputChannel 在注册期创建一次并交给 subscriptions 回收。旧实现每次点击命令都
  // 新建一个且从不 dispose —— 反复触发会持续堆叠输出面板（真实的小泄漏）。
  const debugOutput = vscode.window.createOutputChannel('dsh Debug');
  context.subscriptions.push(
    debugOutput,
    vscode.commands.registerCommand('dsh.debug.captureContext', async () => {
      debugOutput.show(true);
      const attachments = await captureContext();
      debugOutput.appendLine(JSON.stringify(attachments, null, 2));
    })
  );

  // ---- Diff 提供器
  diff.register(context);

  // ---- 工作区信任变化
  // 受限模式是"未启动"而不是"启动失败"：用户点了信任之后没有任何东西会自动补上这一步，
  // 所以必须显式接住 —— 否则信任完还得手动重启窗口，观感像"信任了也没用"。
  context.subscriptions.push(
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      logger.info('工作区已被信任：撤下受限模式提示并启动 daemon');
      panel.notifyTrustChange();
      applyTrustAppearance();
      void daemon.start();
    })
  );

  // ---- 启动 daemon（探测 / 拉起 / 连接；未受信任时由 DaemonManager 拦为 restricted）
  void daemon.start();

  // 集成测试钩子：暴露运行时实例（经 vscode.extensions.getExtension(...).exports 读取）
  return { daemon, diff, panel };
}

export function deactivate(): void {
  // 回收子进程与连接（VSCode 退出前调用）
  activeDaemon?.dispose();
  activeDaemon = undefined;
}
