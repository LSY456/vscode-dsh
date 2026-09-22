/**
 * Webview 宿主：承载对话 UI，并作为 Extension Host 与 Webview 之间的消息桥。
 *
 * 承载形态（两个 surface 共享同一套状态与消息协议）：
 *  - 侧边栏 View（`dsh.agentView`）：常驻入口，点活动栏图标即可用；
 *  - 编辑器面板（命令 `dsh.openEditor`）：需要大屏审阅长回答 / Diff 时使用。
 *
 * 消息协议（webview <-> extension，均通过 postMessage）：
 *   extension -> webview:
 *     { kind: 'status', status, detail }
 *     { kind: 'event', method, params }      // daemon 协议事件原样转发
 *       - method='user.message' 额外带 attachments：本次捕获到的上下文 chip 摘要（仅展示）
 *       - method='notice' 为扩展本地提示（非 daemon 事件），渲染为系统消息
 *     { kind: 'session.reset', sessionId }   // 清空视图（新建会话 / 切换会话 / 断线重放前）
 *     { kind: 'init', state }                // 某个 surface 就绪后的初始状态（含挂起项快照）
 *   webview -> extension:
 *     { kind: 'ready' } { kind: 'send', prompt } { kind: 'cancel' }
 *     { kind: 'session.new' } { kind: 'history.open', sessionId }
 *     { kind: 'approval.respond', approvalId, approved, trust? }
 *     { kind: 'patch.accept'|'patch.reject'|'patch.openDiff'|'patch.applyEdited', patchId }
 *     { kind: 'settings.get'|'settings.apply' } { kind: 'daemon.restart' }
 *     { kind: 'trust.list'|'trust.clear' }
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  Attachment,
  ERROR_CODES,
  EVENTS,
  EventApprovalRequest,
  EventFilePatchPending,
  EventFilePatchResult,
  EventMessageDelta,
  EventSessionEnded,
  EventSessionStarted,
  METHODS,
  SessionCreateResult,
  SessionResumeResult,
} from '../shared/protocol';
import { captureContext } from './contextCapture';
import { ConfigAccessor } from './configAccessor';
import { DaemonManager } from './daemonManager';
import { DshDiffManager } from './diffProvider';
import { logger } from './logger';
import { FileMemento, SessionHistoryStore, SessionSummary } from './sessionHistory';

/** 侧边栏视图 id（package.json contributes.views 必须与此一致） */
export const VIEW_ID = 'dsh.agentView';

/** 待审批 / 待审查快照：surface 重建时用于恢复挂起卡片与待办条 */
type PendingApproval = EventApprovalRequest & { expiresAt?: number };
type PendingPatch = EventFilePatchPending & { expiresAt?: number };

interface ToWebview {
  kind: 'status' | 'event' | 'init' | 'session.reset';
  status?: string;
  detail?: string;
  method?: string;
  params?: unknown;
  sessionId?: string;
  /** session.reset 的成因：新建 / 切换 / 断线重放（UI 据此提示不同文案） */
  reason?: 'new' | 'switch' | 'replay';
  state?: {
    sessionId: string;
    connected: boolean;
    history?: SessionSummary[];
    agent?: 'mock' | 'real';
    model?: string;
    daemonVersion?: string;
    pending?: { approvals: PendingApproval[]; patches: PendingPatch[] };
  };
}

interface FromWebview {
  kind:
    | 'ready'
    | 'send'
    | 'cancel'
    | 'session.new'
    | 'approval.respond'
    | 'patch.accept'
    | 'patch.reject'
    | 'patch.openDiff'
    | 'patch.applyEdited'
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
  private view: vscode.WebviewView | undefined;
  private panel: vscode.WebviewPanel | undefined;
  /** 已就绪（发过 ready）的 webview：所有广播都只发给这些 */
  private readonly readyWebviews = new Set<vscode.Webview>();
  private readyWaiters: (() => void)[] = [];
  private readonly history: SessionHistoryStore;
  /** 挂起项：approval.request / file.patch.pending 后登记，respond/result 后移除 */
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly pendingPatches = new Map<string, PendingPatch>();
  /** 正在重放的会话（断线重连 / 切换会话）：重放事件不回写历史，避免重复落库 */
  private replayingSessionId = '';

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly daemon: DaemonManager,
    private readonly diff: DshDiffManager,
    private readonly configAccessor: ConfigAccessor
  ) {
    this.history = new SessionHistoryStore(new FileMemento(this.resolveHistoryFile()));

    // 订阅 daemon 事件：补丁事件先交给 Diff 管理器，再登记挂起项、回写历史并广播给所有 surface
    this.daemon.client.onEvent((n) => {
      if (n.method === EVENTS.FilePatchPending) {
        this.diff.handlePatchPending(n.params as EventFilePatchPending);
        const p = n.params as PendingPatch;
        if (p?.patchId) this.pendingPatches.set(p.patchId, p);
      } else if (n.method === EVENTS.FilePatchResult) {
        this.diff.handlePatchResult(n.params as EventFilePatchResult);
        const r = n.params as EventFilePatchResult;
        if (r?.patchId) this.pendingPatches.delete(r.patchId);
      } else if (n.method === EVENTS.ApprovalRequest) {
        const a = n.params as PendingApproval;
        if (a?.approvalId) this.pendingApprovals.set(a.approvalId, a);
      } else if (n.method === EVENTS.SessionEnded) {
        // 会话结束：挂起项已被 daemon 按拒绝解除
        this.clearPending();
      }
      this.recordEvent(n.method, n.params);
      this.post({ kind: 'event', method: n.method, params: n.params });
    });

    // 断线重连：daemon 会重放事件缓冲，先把视图清空，避免同一段回答被叠加渲染
    this.daemon.onBeforeResume((sessionId) => this.beginReplay(sessionId));

    this.daemon.onStatus((info) => {
      this.post({ kind: 'status', status: info.status, detail: info.detail });
    });
  }

  /** 注册侧边栏视图（活动栏入口）。 */
  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        VIEW_ID,
        { resolveWebviewView: (view) => this.resolveWebviewView(view) },
        { webviewOptions: { retainContextWhenHidden: true } }
      )
    );
  }

  private resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'out', 'media')],
    };
    view.webview.html = this.getHtml(view.webview);
    view.webview.onDidReceiveMessage((msg: FromWebview) => void this.handleMessage(msg, view.webview));
    view.onDidDispose(() => {
      this.readyWebviews.delete(view.webview);
      if (this.view === view) this.view = undefined;
    });
  }

  /**
   * 从 daemon 事件流构建会话历史（会话开始/回答流/结束）。
   * 重放期间（断线重连 / 切回旧会话）跳过：事件是历史的重播，重复落库会产生重复回答。
   */
  private recordEvent(method: string, params: unknown): void {
    const sid = (params as { sessionId?: string } | null)?.sessionId;
    if (!sid) return;
    if (this.replayingSessionId && this.replayingSessionId === sid) return;
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

  /** 历史文件路径：优先工作区 .dsh/history.json，无工作区时退化为扩展全局存储。 */
  private resolveHistoryFile(): string {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (root) return path.join(root, '.dsh', 'history.json');
    return path.join(this.context.globalStorageUri.fsPath, 'history.json');
  }

  /** 打开/聚焦侧边栏视图（常驻入口）；已开编辑器面板则优先聚焦面板。 */
  async reveal(): Promise<void> {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    if (this.view) {
      this.view.show(true);
      return;
    }
    try {
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    } catch (err) {
      logger.warn(`聚焦 dsh 视图失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 在编辑器列打开大屏面板（适合审阅长回答 / 反复看 Diff）。 */
  createOrShowEditorPanel(): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    if (this.panel) {
      this.panel.reveal(column);
      return;
    }
    const panel = vscode.window.createWebviewPanel('dshAgent', 'dsh Agent', column, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'out', 'media')],
    });
    this.panel = panel;
    panel.webview.html = this.getHtml(panel.webview);
    panel.webview.onDidReceiveMessage((msg: FromWebview) => void this.handleMessage(msg, panel.webview));
    panel.onDidDispose(() => {
      this.readyWebviews.delete(panel.webview);
      if (this.panel === panel) this.panel = undefined;
    });
  }

  /** 新建会话：向 daemon 申请新 sessionId，并让所有 surface 清空视图。 */
  async newSession(): Promise<string> {
    if (!this.daemon.client.isOpen) {
      throw new Error('daemon 未连接');
    }
    const result = await this.daemon.client.request<SessionCreateResult>(METHODS.SessionCreate, {});
    this.daemon.setSessionId(result.sessionId);
    this.clearPending();
    this.post({ kind: 'session.reset', sessionId: result.sessionId, reason: 'new' });
    return result.sessionId;
  }

  /**
   * 打开历史会话（面板历史列表 / 集成测试入口）。
   * 返回 true = 已真实切回该会话（事件已重放，可继续对话）；
   * 返回 false = daemon 已不认识它（例如重启过），已退化为只读回放并新开一个会话。
   */
  async openHistorySession(sessionId: string): Promise<boolean> {
    if (!sessionId) return false;
    if (await this.switchSession(sessionId)) return true;
    // 只读回放 + 新开会话：避免用户看着旧会话继续输入却发进失效会话
    const rec = this.history.get(sessionId);
    try {
      await this.newSession();
    } catch (err) {
      logger.warn(`切回历史时新建会话失败: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (rec) this.post({ kind: 'event', method: 'history.loaded', params: rec });
    this.post({
      kind: 'event',
      method: 'notice',
      params: { text: '该会话已结束（daemon 重启过），此处为历史回放；发送消息将开启新会话。' },
    });
    return false;
  }

  /** 已就绪的 webview surface 数量（侧边栏视图 + 编辑器面板），集成测试与诊断用。 */
  getReadySurfaceCount(): number {
    return this.readyWebviews.size;
  }

  /**
   * 让 daemon 重放指定会话的事件缓冲并切为当前会话（可继续对话）。
   * daemon 已不认识该会话（进程重启过）时返回 false。
   */
  private async switchSession(sessionId: string): Promise<boolean> {
    if (!sessionId || !this.daemon.client.isOpen) return false;
    this.beginReplay(sessionId, 'switch');
    try {
      const resumed = await this.daemon.client.request<SessionResumeResult>(METHODS.SessionResume, { sessionId });
      this.daemon.setSessionId(resumed.sessionId);
      return true;
    } catch (err) {
      const code = (err as { code?: number } | null)?.code;
      if (code === ERROR_CODES.NotFound) return false;
      void vscode.window.showErrorMessage(
        `切换会话失败: ${err instanceof Error ? err.message : String(err)}`
      );
      return false;
    } finally {
      this.replayingSessionId = '';
    }
  }

  /** 重放开始：通知 surface 清空并抑制历史重复落库（重放事件在 resume 响应前全部到达）。 */
  private beginReplay(sessionId: string, reason: 'switch' | 'replay' = 'replay'): void {
    this.replayingSessionId = sessionId;
    this.clearPending();
    this.post({ kind: 'session.reset', sessionId, reason });
  }

  private clearPending(): void {
    this.pendingApprovals.clear();
    this.pendingPatches.clear();
  }

  /** 供 “dsh.sendSelection” 等命令使用：打开视图、等待就绪后直接发送。 */
  async sendPrompt(prompt: string): Promise<void> {
    await this.reveal();
    if (this.readyWebviews.size === 0) {
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

  private async handleMessage(msg: FromWebview, webview: vscode.Webview): Promise<void> {
    switch (msg.kind) {
      case 'ready':
        this.readyWebviews.add(webview);
        this.readyWaiters.splice(0).forEach((r) => r());
        void webview.postMessage({ kind: 'init', state: this.buildInitState() });
        return;
      case 'send':
        await this.doSend((msg.prompt ?? '').trim());
        return;
      case 'session.new': {
        try {
          await this.newSession();
        } catch (err) {
          void vscode.window.showErrorMessage(
            `新建会话失败: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        return;
      }
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
            void vscode.window.showWarningMessage('审批已过期，按拒绝处理');
          } else if (code === ERROR_CODES.NotFound) {
            this.post({ kind: 'event', method: 'approval.expired', params: { approvalId: msg.approvalId } });
          } else {
            void vscode.window.showErrorMessage(
              `审批回传失败: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        } finally {
          this.pendingApprovals.delete(msg.approvalId);
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
        await this.openHistorySession(msg.sessionId ?? '');
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
    }
  }

  /** surface 就绪时的初始状态：会话、历史列表、Agent 实现、挂起项快照。 */
  private buildInitState(): NonNullable<ToWebview['state']> {
    const now = Date.now();
    for (const [id, a] of this.pendingApprovals) {
      if (typeof a.expiresAt === 'number' && a.expiresAt <= now) this.pendingApprovals.delete(id);
    }
    for (const [id, p] of this.pendingPatches) {
      if (typeof p.expiresAt === 'number' && p.expiresAt <= now) this.pendingPatches.delete(id);
    }
    return {
      sessionId: this.daemon.getSessionId(),
      connected: this.daemon.client.isOpen,
      history: this.history.list(),
      ...this.daemon.getAgentInfo(),
      pending: {
        approvals: [...this.pendingApprovals.values()],
        patches: [...this.pendingPatches.values()],
      },
    };
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
      // 先捕获上下文：用户消息回显时带上「Agent 看到了什么」的 chip
      // （上下文保真是本插件的核心能力，UI 需要让用户看见实际发送了什么）
      let attachments: Attachment[] = [];
      try {
        attachments = await captureContext();
      } catch (err) {
        logger.warn(`上下文捕获失败，按无附件发送: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.post({
        kind: 'event',
        method: 'user.message',
        params: { text: prompt, attachments: summarizeAttachments(attachments) },
      });
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
    for (const webview of [...this.readyWebviews]) {
      try {
        void webview.postMessage(msg);
      } catch {
        this.readyWebviews.delete(webview);
      }
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const mediaDir = path.join(this.context.extensionPath, 'out', 'media');
    let html = fs.readFileSync(path.join(mediaDir, 'webview.html'), 'utf8');
    const nonce = requireCryptoRandom();
    html = html.replace(/__NONCE__/g, nonce);
    const webviewUri = (file: string) =>
      webview
        .asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'out', 'media', file))
        .toString();
    html = html.replace(/__CSS_URI__/g, webviewUri('webview.css'));
    html = html.replace(/__JS_URI__/g, webviewUri('webview.js'));
    return html;
  }
}

/**
 * 把捕获到的附件折叠为 UI chip 文案，让用户一眼看到 Agent 实际拿到了什么上下文。
 * 只做展示，不影响发送给 daemon 的原始附件。
 */
function summarizeAttachments(attachments: Attachment[]): { label: string }[] {
  const chips: { label: string }[] = [];
  let gitChip: string | undefined;

  for (const a of attachments) {
    switch (a.kind) {
      case 'file':
        chips.push({ label: (a.name || '文件') + (a.contentOmitted ? '（大文件，按需读取）' : '') });
        break;
      case 'selection':
        chips.push({
          label: a.range ? `选区 L${a.range.startLine}-${a.range.endLine}` : '选区',
        });
        break;
      case 'diagnostics': {
        const n = Array.isArray(a.diagnostics) ? a.diagnostics.length : 0;
        chips.push({ label: `${a.name || '诊断'} ${n} 条` });
        break;
      }
      case 'gitStatus': {
        const changed = (a.gitStatus || '')
          .split('\n')
          .filter((l) => l.trim() && !l.startsWith('##')).length;
        gitChip = changed > 0 ? `git ${changed} 处改动` : 'git 工作区干净';
        break;
      }
      default:
        break;
    }
  }
  if (gitChip) chips.push({ label: gitChip });

  const MAX_CHIPS = 6;
  if (chips.length > MAX_CHIPS) {
    const extra = chips.length - MAX_CHIPS + 1;
    return [...chips.slice(0, MAX_CHIPS - 1), { label: `+${extra}` }];
  }
  return chips;
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
