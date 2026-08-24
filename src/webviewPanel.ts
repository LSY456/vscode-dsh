/**
 * Webview 面板宿主：承载对话 UI，并作为 Extension Host 与 Webview 之间的消息桥。
 *
 * 消息协议（webview <-> extension，均通过 postMessage）：
 *   extension -> webview:
 *     { kind: 'status', status, detail }
 *     { kind: 'event', method, params }      // daemon 协议事件原样转发
 *     { kind: 'init', state }                // 面板就绪后的初始状态
 *   webview -> extension:
 *     { kind: 'ready' } { kind: 'send', prompt } { kind: 'cancel' }
 *     { kind: 'approval.respond', approvalId, approved }
 *     { kind: 'patch.accept'|'patch.reject'|'patch.openDiff', patchId }
 *     { kind: 'clear' }
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  ERROR_CODES,
  EVENTS,
  EventFilePatchPending,
  EventFilePatchResult,
  EventMessageDelta,
  EventSessionEnded,
  EventSessionStarted,
  METHODS,
} from '../shared/protocol';
import { captureContext } from './contextCapture';
import { ConfigAccessor } from './configAccessor';
import { DaemonManager } from './daemonManager';
import { DshDiffManager } from './diffProvider';
import { SessionHistoryStore, SessionSummary } from './sessionHistory';

interface ToWebview {
  kind: 'status' | 'event' | 'init';
  status?: string;
  detail?: string;
  method?: string;
  params?: unknown;
  state?: { sessionId: string; connected: boolean; history?: SessionSummary[] };
}

interface FromWebview {
  kind:
    | 'ready'
    | 'send'
    | 'cancel'
    | 'approval.respond'
    | 'patch.accept'
    | 'patch.reject'
    | 'patch.openDiff'
    | 'patch.applyEdited'
    | 'clear'
    | 'history.open'
    | 'settings.get'
    | 'settings.apply'
    | 'daemon.restart'
    | 'trust.list'
    | 'trust.clear';
  prompt?: string;
  approvalId?: string;
  approved?: boolean;
  /** B1 信任记忆：审批通过并记住（免审批白名单） */
  trust?: boolean;
  patchId?: string;
  sessionId?: string;
  /** 设置面板提交项；apiKey 留空表示不修改 */
  settings?: { apiKey?: string; model?: string; baseURL?: string; preset?: string; provider?: string };
}

export class WebviewPanelHost {
  private panel: vscode.WebviewPanel | undefined;
  private ready = false;
  private readyWaiters: (() => void)[] = [];
  private readonly history: SessionHistoryStore;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly daemon: DaemonManager,
    private readonly diff: DshDiffManager,
    private readonly configAccessor: ConfigAccessor
  ) {
    this.history = new SessionHistoryStore(context.workspaceState);
    // 订阅 daemon 事件并转发到面板（同时拦截补丁事件交给 Diff 管理器）
    this.daemon.client.onEvent((n) => {
      if (n.method === EVENTS.FilePatchPending) {
        this.diff.handlePatchPending(n.params as EventFilePatchPending);
      } else if (n.method === EVENTS.FilePatchResult) {
        this.diff.handlePatchResult(n.params as EventFilePatchResult);
      }
      this.recordEvent(n.method, n.params);
      this.post({ kind: 'event', method: n.method, params: n.params });
    });
    // 订阅 daemon 状态变化
    this.daemon.onStatus((info) => {
      this.post({ kind: 'status', status: info.status, detail: info.detail });
    });
  }

  /** 从 daemon 事件流构建会话历史（会话开始/回答流/结束）。 */
  private recordEvent(method: string, params: unknown): void {
    const sid = (params as { sessionId?: string } | null)?.sessionId;
    if (!sid) return;
    switch (method) {
      case EVENTS.SessionStarted:
        this.history.startSession(sid, (params as EventSessionStarted).title);
        break;
      case EVENTS.MessageDelta:
        this.history.appendAssistantDelta(sid, (params as EventMessageDelta).delta);
        break;
      case EVENTS.MessageDone:
        this.history.finishAssistant(sid);
        break;
      case EVENTS.SessionEnded:
        this.history.endSession(sid);
        break;
      default:
        break;
    }
  }

  createOrShow(): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    if (this.panel) {
      this.panel.reveal(column);
      return;
    }
    this.panel = vscode.window.createWebviewPanel('dshAgent', 'dsh Agent', column, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'out', 'media')],
    });
    this.panel.webview.html = this.getHtml();
    this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.ready = false;
    });
    this.panel.webview.onDidReceiveMessage((msg: FromWebview) => {
      void this.handleMessage(msg);
    });
  }

  reveal(): void {
    this.panel?.reveal();
  }

  /** 供 “dsh.sendSelection” 等命令使用：打开面板、等待就绪后直接发送。 */
  async sendPrompt(prompt: string): Promise<void> {
    this.createOrShow();
    if (!this.ready) {
      await new Promise<void>((resolve) => {
        this.readyWaiters.push(resolve);
        setTimeout(() => {
          const i = this.readyWaiters.indexOf(resolve);
          if (i >= 0) this.readyWaiters.splice(i, 1);
          resolve();
        }, 5000);
      });
    }
    await this.doSend(prompt);
  }

  private async handleMessage(msg: FromWebview): Promise<void> {
    switch (msg.kind) {
      case 'ready':
        this.ready = true;
        this.readyWaiters.forEach((r) => r());
        this.readyWaiters = [];
        this.post({
          kind: 'init',
          state: {
            sessionId: this.daemon.getSessionId(),
            connected: this.daemon.client.isOpen,
            history: this.history.list(),
          },
        });
        return;
      case 'send':
        await this.doSend((msg.prompt ?? '').trim());
        return;
      case 'cancel': {
        const sessionId = this.daemon.getSessionId();
        if (sessionId) {
          try {
            await this.daemon.client.request(METHODS.SessionCancel, { sessionId });
          } catch {
            /* 忽略：daemon 可能已完成 */
          }
        }
        return;
      }
      case 'approval.respond': {
        if (!msg.approvalId) return;
        try {
          await this.daemon.client.request(METHODS.ApprovalRespond, {
            sessionId: this.daemon.getSessionId(),
            approvalId: msg.approvalId,
            approved: !!msg.approved,
            trust: msg.trust,
          });
        } catch (err) {
          const code = (err as { code?: number } | null)?.code;
          if (code === ERROR_CODES.Expired) {
            // 审批已过期：通知 Webview 将卡片标记为过期并置灰
            this.post({ kind: 'event', method: 'approval.expired', params: { approvalId: msg.approvalId } });
            void vscode.window.showWarningMessage('审批已过期（60s 未响应），按拒绝处理');
          } else if (code === ERROR_CODES.NotFound) {
            this.post({ kind: 'event', method: 'approval.expired', params: { approvalId: msg.approvalId } });
          } else {
            void vscode.window.showErrorMessage(
              `审批回传失败: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
        return;
      }
      case 'patch.accept':
        if (msg.patchId) await this.diff.respond(msg.patchId, true);
        return;
      case 'patch.reject':
        if (msg.patchId) await this.diff.respond(msg.patchId, false);
        return;
      case 'patch.openDiff':
        if (msg.patchId) await this.diff.openDiff(msg.patchId);
        return;
      case 'patch.applyEdited':
        if (msg.patchId) await this.diff.applyEdited(msg.patchId);
        return;
      case 'history.open': {
        const rec = this.history.get(msg.sessionId ?? '');
        if (rec) this.post({ kind: 'event', method: 'history.loaded', params: rec });
        return;
      }
      case 'settings.get': {
        const config = this.configAccessor.getPanelConfig();
        const hasApiKey = await this.configAccessor.hasApiKey();
        this.post({ kind: 'event', method: 'settings.loaded', params: { config, hasApiKey } });
        return;
      }
      case 'settings.apply': {
        const s = msg.settings ?? {};
        if (s.apiKey !== undefined) await this.configAccessor.setApiKey(s.apiKey);
        await this.configAccessor.applyPanelConfig(s);
        this.post({ kind: 'event', method: 'settings.applied', params: { restartNeeded: true } });
        return;
      }
      case 'daemon.restart':
        await this.daemon.restart();
        this.post({ kind: 'event', method: 'daemon.restarted', params: {} });
        return;
      case 'trust.list': {
        try {
          const result = (await this.daemon.client.request(METHODS.TrustList, {})) as {
            rules: unknown[];
          };
          this.post({ kind: 'event', method: 'trust.loaded', params: { rules: result?.rules ?? [] } });
        } catch (err) {
          this.post({ kind: 'event', method: 'trust.loaded', params: { rules: [], error: String(err) } });
        }
        return;
      }
      case 'trust.clear': {
        await this.daemon.client.request(METHODS.TrustClear, {});
        this.post({ kind: 'event', method: 'trust.loaded', params: { rules: [] } });
        void vscode.window.showInformationMessage('已清空全部信任命令');
        return;
      }
      case 'clear':
        // Webview 自行清空 DOM；扩展侧无需处理
        return;
    }
  }

  private async doSend(prompt: string): Promise<void> {
    if (!prompt) {
      void vscode.window.showWarningMessage('请输入 Prompt');
      return;
    }
    if (!this.daemon.client.isOpen) {
      void vscode.window.showErrorMessage('daemon 未连接，请检查状态栏或运行 “dsh: 查看 Daemon 状态”');
      return;
    }
    try {
      // 先回显用户消息，再捕获上下文并发送
      this.post({ kind: 'event', method: 'user.message', params: { text: prompt } });
      const attachments = await captureContext();
      const sessionId = this.daemon.getSessionId();
      if (sessionId) this.history.appendUser(sessionId, prompt);
      await this.daemon.client.request(METHODS.SessionSend, { sessionId, prompt, attachments });
    } catch (err) {
      void vscode.window.showErrorMessage(
        `发送失败: ${err instanceof Error ? err.message : String(err)}`
      );
      this.post({
        kind: 'event',
        method: EVENTS.Error,
        params: { message: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  private post(msg: ToWebview): void {
    if (!this.panel) return;
    try {
      void this.panel.webview.postMessage(msg);
    } catch {
      /* 面板已销毁 */
    }
  }

  private getHtml(): string {
    const mediaDir = path.join(this.context.extensionPath, 'out', 'media');
    let html = fs.readFileSync(path.join(mediaDir, 'webview.html'), 'utf8');
    const nonce = requireCryptoRandom();
    html = html.replace(/__NONCE__/g, nonce);
    // 资源路径：webview 通过 asWebviewUri 引用媒体文件
    const webviewUri = (file: string) =>
      this.panel!.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'out', 'media', file)).toString();
    html = html.replace(/__CSS_URI__/g, webviewUri('webview.css'));
    html = html.replace(/__JS_URI__/g, webviewUri('webview.js'));
    return html;
  }
}

function requireCryptoRandom(): string {
  // 轻量随机 nonce（CSP 用），无需引入 crypto 依赖
  let s = '';
  const bytes = new Uint8Array(16);
  const crypto = (globalThis as { crypto?: { getRandomValues?(a: Uint8Array): Uint8Array } }).crypto;
  if (crypto?.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}
