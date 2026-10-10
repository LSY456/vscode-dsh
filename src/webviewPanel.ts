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
 *       - method='agent.info' 为扩展本地事件：当前 Agent 实现（mock/real + 成因），
 *         驱动「演示模式」横幅与模式 chip（配好 Key 重启后据此撤下横幅）
 *       - method='trust.info' 为扩展本地事件：工作区信任状态（受限模式横幅）。未信任时 daemon
 *         不会启动，所以这是撤下横幅的唯一来源，与 agent.info 同一套本地事件机制
 *       - method='balance.info' 为扩展本地事件：账户余额（状态行 chip）。走独立事件而不进 init 快照，
 *         因为它带 TTL 缓存且有"不适用"这种状态，需要在 surface 就绪之后随时补推
 *     { kind: 'session.reset', sessionId }   // 清空视图（新建会话 / 切换会话 / 断线重放前）
 *     { kind: 'init', state }                // 某个 surface 就绪后的初始状态（含挂起项快照 + trust）
 *   webview -> extension:
 *     { kind: 'ready' } { kind: 'send', prompt } { kind: 'cancel' }
 *     { kind: 'session.new' } { kind: 'history.open', sessionId }
 *     { kind: 'approval.respond', approvalId, approved, trust? }
 *     { kind: 'patch.accept'|'patch.reject'|'patch.openDiff'|'patch.applyEdited', patchId }
 *     { kind: 'settings.get'|'settings.apply' } { kind: 'daemon.restart' }
 *     { kind: 'trust.list'|'trust.clear' } { kind: 'trust.manage' }
 *     { kind: 'balance.refresh' }            // 点余额 chip 手动重取
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
  EventPlanRequest,
  EventMessageDelta,
  EventSessionEnded,
  EventSessionStarted,
  METHODS,
  SessionCreateResult,
  SessionResumeResult,
  SessionRollbackResult,
} from '../shared/protocol';
import { captureContext } from './contextCapture';
import { sanitizeImageAttachments, type ImageAttachmentInput } from '../shared/imageAttachment';
import { ConfigAccessor } from './configAccessor';
import {
  BALANCE_TTL_MS,
  type BalancePayload,
  balanceEndpointCandidates,
  buildBalancePayload,
  describeBalanceEndpoint,
  fetchBalance,
} from './accountBalance';
import { DaemonManager } from './daemonManager';
import { renderWebviewHtml } from './webviewHtml';
import { DshDiffManager } from './diffProvider';
import { DirtyTracker } from './dirtyTracker';
import { logger } from './logger';
import {
  type ModelCatalogCache,
  type ModelCatalogMeta,
  type ModelFetchFailure,
  type ModelOption,
  MODEL_CATALOG_TTL_MS,
  buildModelCatalog,
  endpointHostOf,
  isModelCatalogCacheFresh,
  isOfficialDeepSeekEndpoint,
  modelEndpointCandidates,
  normalizeModelBaseUrl,
  shouldAttemptModelFetch,
  describeFetchFailure,
} from './modelCatalog';
import { fetchModelIds } from './modelCatalogFetch';
import { formatRollbackReport } from './rollbackReport';
import { DEFAULT_MAX_SESSIONS, FileMemento, SessionHistoryStore, SessionSummary } from './sessionHistory';
import { openTrustManagement } from './trustCommands';
import { resolveWorkspaceRoot } from './workspaceRoot';
import { resolveTrustGate, TrustGate } from './workspaceTrust';

/** 侧边栏视图 id（package.json contributes.views 必须与此一致） */
export const VIEW_ID = 'dsh.agentView';

/** 待审批 / 待审查快照：surface 重建时用于恢复挂起卡片与待办条 */
type PendingApproval = EventApprovalRequest & { expiresAt?: number };
type PendingPatch = EventFilePatchPending & { expiresAt?: number };
type PendingPlan = EventPlanRequest & { expiresAt?: number };

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
    agentReason?: 'no-api-key' | 'forced-mock';
    model?: string;
    daemonVersion?: string;
    pending?: { approvals: PendingApproval[]; patches: PendingPatch[]; plans: PendingPlan[] };
    /** 工作区信任状态快照：受限模式横幅据此显示（未声明 = 已信任） */
    trust?: TrustGate;
  };
}

interface FromWebview {
  kind:
    | 'ready'
    | 'send'
    | 'cancel'
    | 'session.new'
    | 'approval.respond'
    | 'plan.respond'
    | 'patch.accept'
    | 'patch.reject'
    | 'patch.openDiff'
    | 'patch.applyEdited'
    | 'history.open'
    | 'settings.get'
    | 'settings.apply'
    | 'daemon.restart'
    | 'trust.list'
    | 'trust.clear'
    | 'trust.manage'
    | 'balance.refresh'
    | 'ui.diag';
  /** webview 侧诊断（事件渲染抛错 / 未知事件）：只落 OutputChannel，不改变产品行为 */
  diag?: { level: 'warn' | 'debug'; method?: string; message?: string };
  prompt?: string;
  /**
   * 面板暂存的图片（粘贴 / 拖放 / 选择文件）。
   * 到这里**还没校验过** —— 它是 webview 传来的任意数据，doSend 里一律先过
   * `sanitizeImageAttachments` 再用，绝不直接转发给 daemon。
   */
  images?: ImageAttachmentInput[];
  approvalId?: string;
  approved?: boolean;
  /** B1 信任记忆：审批通过并记住（免审批白名单） */
  trust?: boolean;
  /** P2-7：计划卡的批准 / 拒绝 */
  planId?: string;
  /** P2-7：批准计划时附带的补充意见（执行阶段以它为准） */
  note?: string;
  /** P2-7：输入框的「计划」开关 —— 本轮先出计划、批准后才执行 */
  planMode?: boolean;
  patchId?: string;
  sessionId?: string;
  /** 设置面板提交项；apiKey 留空表示不修改 */
  settings?: {
    apiKey?: string;
    model?: string;
    baseURL?: string;
    preset?: string;
    provider?: string;
    /** Agent 循环预算（P2-2）：面板里的两个数字输入；区间在 ConfigAccessor 侧收敛 */
    maxToolRounds?: number;
    maxContextTokens?: number;
    /** 采样参数（批次 2）：温度 0–2；maxTokens 未配置即不下发（由服务端决定上限） */
    temperature?: number;
    maxTokens?: number;
  };
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
  private readonly pendingPlans = new Map<string, PendingPlan>();
  /** 正在重放的会话（断线重连 / 切换会话）：重放事件不回写历史，避免重复落库 */
  private replayingSessionId = '';
  /** 模型目录缓存（在线模型列表）：内存 + globalState 双写，避免每次打开设置面板都打网络 */
  private catalogCache: ModelCatalogCache | undefined;
  /** 进行中的目录刷新：多个 surface 同时打开设置时只打一次网络 */
  private catalogRefresh: Promise<void> | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly daemon: DaemonManager,
    private readonly diff: DshDiffManager,
    private readonly configAccessor: ConfigAccessor,
    /** P0-1：发消息前冲刷脏文档快照，确保 daemon 看到的是此刻的缓冲区 */
    private readonly dirty?: DirtyTracker
  ) {
    this.history = new SessionHistoryStore(new FileMemento(this.resolveHistoryFile()), Date.now, {
      // 保留条数每次裁剪时现读配置：用户在设置里改动后立刻生效，无需重开面板
      maxSessions: () =>
        vscode.workspace.getConfiguration('dsh').get<number>('history.maxSessions', DEFAULT_MAX_SESSIONS),
    });

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
      } else if (n.method === EVENTS.PlanRequest) {
        const pl = n.params as PendingPlan;
        if (pl?.planId) this.pendingPlans.set(pl.planId, pl);
      } else if (n.method === EVENTS.SessionEnded) {
        // 会话结束：挂起项已被 daemon 按拒绝解除
        this.clearPending();
        // 这一轮把 token 用掉了 → 余额可能变了。TTL 会自动把重连重放等重复触发挡掉
        void this.refreshBalance();
      }
      this.recordEvent(n.method, n.params);
      this.post({ kind: 'event', method: n.method, params: n.params });
    });

    // 断线重连：daemon 会重放事件缓冲，先把视图清空，避免同一段回答被叠加渲染
    this.daemon.onBeforeResume((sessionId) => this.beginReplay(sessionId));

    this.daemon.onStatus((info) => {
      this.post({ kind: 'status', status: info.status, detail: info.detail });
    });

    // 每次握手成功后同步「当前 Agent 实现」：用户配好 Key 重启后要能撤下"演示模式"横幅
    this.daemon.onAgentInfo((info) => {
      this.post({ kind: 'event', method: 'agent.info', params: info });
      // 握手成功说明凭据是通的 → 顺手把余额补上（无 Key / 非官方端点会在内部被挡掉）
      void this.refreshBalance();
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
    const ws = resolveWorkspaceRoot(vscode.workspace.workspaceFolders);
    if (ws.ok) return path.join(ws.root, '.dsh', 'history.json');
    return path.join(this.context.globalStorageUri.fsPath, 'history.json');
  }

  // -------------------------------------------------------------------------
  // 模型目录（模型设置面板「模型名」下拉的数据源）
  // -------------------------------------------------------------------------

  /** globalState 里的缓存 key。放全局而非工作区：模型列表属于**端点**，不随工作区变。 */
  private static readonly CATALOG_STATE_KEY = 'dsh.modelCatalog';

  /**
   * 读缓存：首次从 globalState 载入，之后走内存。
   * 不额外设"已载入"标志位 —— globalState.get 是同步内存查表，面板打开频率下无成本。
   */
  private getCatalogCache(): ModelCatalogCache | undefined {
    if (this.catalogCache === undefined) {
      const raw = this.context.globalState.get<ModelCatalogCache>(WebviewPanelHost.CATALOG_STATE_KEY);
      if (raw && typeof raw === 'object' && Array.isArray(raw.models)) this.catalogCache = raw;
    }
    return this.catalogCache;
  }

  private async writeCatalogCache(cache: ModelCatalogCache): Promise<void> {
    this.catalogCache = cache;
    try {
      await this.context.globalState.update(WebviewPanelHost.CATALOG_STATE_KEY, cache);
    } catch (err) {
      // 写不进缓存不是故障：只是下次打开设置面板会再拉一次网络
      logger.warn(`模型目录缓存写入失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async clearCatalogCache(): Promise<void> {
    this.catalogCache = undefined;
    try {
      await this.context.globalState.update(WebviewPanelHost.CATALOG_STATE_KEY, undefined);
    } catch (err) {
      logger.warn(`模型目录缓存清理失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 组装给面板的载荷（列表一律经 buildModelCatalog，保证"当前配置项永远在列表里"）。
   * 「列表从哪来」只经 modelsHint 这一条通道告诉用户 —— 不另发一个机器可读的字段，
   * 免得两处来源说明各自表述、日后对不上。
   */
  private buildCatalogPayload(
    currentModel: string,
    live: string[] | undefined,
    meta: ModelCatalogMeta
  ): { models: ModelOption[]; modelsHint: string } {
    const { models, hint } = buildModelCatalog({ current: currentModel, live, meta });
    return { models, modelsHint: hint };
  }

  /**
   * 面板打开时**立即**返回的目录：有新鲜缓存就用缓存里的在线列表，否则用内置快照。
   * 之所以不等网络：设置面板要秒开，在线列表随后由 settings.models 事件补上。
   */
  private modelCatalogPayload(
    currentModel: string,
    baseURL: string,
    hasApiKey: boolean
  ): { models: ModelOption[]; modelsHint: string } {
    const endpoints = modelEndpointCandidates(baseURL);
    const cache = this.getCatalogCache();
    const fresh = isModelCatalogCacheFresh(cache, baseURL, Date.now());
    const canFetch = shouldAttemptModelFetch({ hasApiKey, officialBase: isOfficialDeepSeekEndpoint(baseURL) });
    return this.buildCatalogPayload(currentModel, fresh ? cache?.models : undefined, {
      source: fresh ? 'cache' : 'builtin',
      endpointHost: endpointHostOf(endpoints[0]),
      fetchedAt: cache?.fetchedAt,
      hasApiKey,
      // 还没发请求，就已经能说清"为什么拿不到在线列表"
      failure: !fresh && !canFetch ? 'no-key' : undefined,
    });
  }

  /**
   * 后台刷新在线模型列表。TTL 内命中缓存直接跳过；
   * 结果（成功或失败原因）都经 settings.models 推给已打开的面板。
   */
  private refreshModelCatalog(
    config: { baseURL: string; model: string },
    hasApiKey: boolean
  ): Promise<void> {
    // 多个 surface 同时打开设置时只打一次网络
    if (this.catalogRefresh) return this.catalogRefresh;

    const baseURL = normalizeModelBaseUrl(config.baseURL);
    if (isModelCatalogCacheFresh(this.getCatalogCache(), baseURL, Date.now())) return Promise.resolve();

    const endpointHost = endpointHostOf(modelEndpointCandidates(baseURL)[0]);
    if (!shouldAttemptModelFetch({ hasApiKey, officialBase: isOfficialDeepSeekEndpoint(baseURL) })) {
      // 没配 Key + 官方端点：/models 必然 401，不发。把原因直接说给用户听。
      this.pushCatalog(config.model, undefined, {
        source: 'builtin',
        endpointHost,
        hasApiKey,
        failure: 'no-key',
      });
      return Promise.resolve();
    }

    this.catalogRefresh = this.runCatalogRefresh(config.model, baseURL, endpointHost).finally(() => {
      this.catalogRefresh = undefined;
    });
    return this.catalogRefresh;
  }

  /** 真正发请求的那一段：成功写缓存；失败只记日志 + 把具体原因推给面板（下次打开会重试）。 */
  private async runCatalogRefresh(currentModel: string, baseURL: string, endpointHost: string): Promise<void> {
    const candidates = modelEndpointCandidates(baseURL);
    const apiKey = await this.configAccessor.getApiKey().catch(() => '');
    const result = await fetchModelIds({ candidates, apiKey });
    const host = endpointHostOf(result.endpoint ?? candidates[0]);

    if (result.ok) {
      const fetchedAt = Date.now();
      await this.writeCatalogCache({ baseURL, fetchedAt, models: result.ids, endpoint: result.endpoint });
      this.pushCatalog(currentModel, result.ids, {
        source: 'live',
        endpointHost: host,
        fetchedAt,
        hasApiKey: !!apiKey,
      });
      logger.info(`在线模型列表已更新：${result.ids.length} 个（${host}）`);
      return;
    }

    const failure: ModelFetchFailure = result.failure ?? 'network';
    logger.info(
      `在线模型列表获取失败：${describeFetchFailure(failure, result.detail)}（端点 ${host || endpointHost}）`
    );
    this.pushCatalog(currentModel, undefined, {
      source: 'builtin',
      endpointHost: host || endpointHost,
      hasApiKey: !!apiKey,
      failure,
      failureDetail: result.detail,
    });
  }

  /** 推送出口：只换下拉选项与来源说明，不动用户此刻的选择（保留逻辑在 webview 侧）。 */
  private pushCatalog(currentModel: string, live: string[] | undefined, meta: ModelCatalogMeta): void {
    this.post({
      kind: 'event',
      method: 'settings.models',
      params: this.buildCatalogPayload(currentModel, live, meta),
    });
  }

  // -------------------------------------------------------------------------
  // 账户余额（状态行上的余额 chip）
  // -------------------------------------------------------------------------

  /** 最近一次读到的余额（推给面板的形态；`{available:false}` = 明确不可用） */
  private balancePayload: BalancePayload | undefined;
  /** 最近一次**尝试**的时间（成功/失败都算）：把网络请求节流到一个 TTL 一次 */
  private balanceAttemptAt = 0;
  /** 配置代次：换 Key / 换端点时自增，用来丢弃"属于旧配置"的迟到结果 */
  private balanceEpoch = 0;
  /** 在飞的余额请求（并发去重） */
  private balanceRefreshInFlight: Promise<void> | undefined;

  /**
   * 刷新账户余额并推给面板。
   *
   * 触发点：surface 就绪、握手成功、会话结束（token 用掉了）、用户点击、改了 Key/端点。
   * `force` 的含义是"绕过 TTL 且作废在飞结果的落地"（换 Key 后必须重取、用户点了要立刻重取），
   * **它不清空当前显示**：手动刷新失败时，屏幕上那笔已知余额比一片空白有用
   * （真要撤下旧账号的数字时，由调用方先 `clearBalance()`）。
   */
  private refreshBalance(force = false): Promise<void> {
    if (force) {
      this.balanceEpoch += 1;
      this.balanceAttemptAt = 0;
    }
    if (this.balanceRefreshInFlight) {
      // 在飞的那次收尾后按当前配置再来一次；在飞那次的结果会被 epoch 检查丢弃
      return force ? this.balanceRefreshInFlight.then(() => this.refreshBalance()) : this.balanceRefreshInFlight;
    }
    if (this.balancePayload !== undefined && Date.now() - this.balanceAttemptAt < BALANCE_TTL_MS) {
      // 命中 TTL 也仍然重推一次：新开的 surface 要能立刻拿到，而不是等下一次刷新
      this.pushBalance(this.balancePayload);
      return Promise.resolve();
    }
    this.balanceRefreshInFlight = this.runBalanceRefresh().finally(() => {
      this.balanceRefreshInFlight = undefined;
    });
    return this.balanceRefreshInFlight;
  }

  private async runBalanceRefresh(): Promise<void> {
    const epoch = this.balanceEpoch;
    const baseURL = normalizeModelBaseUrl(this.configAccessor.getPanelConfig().baseURL);

    // `/user/balance` 是 DeepSeek 的**账户级**接口：非官方端点直接视为"不适用"。
    // 既不会产生必然的 404，也不必为"锦上添花的展示"把 API Key 送到用户自配的第三方网关去。
    if (!isOfficialDeepSeekEndpoint(baseURL)) {
      this.clearBalance(epoch);
      return;
    }

    const apiKey = await this.configAccessor.getApiKey().catch(() => '');
    if (epoch !== this.balanceEpoch) return;
    if (!apiKey) {
      this.clearBalance(epoch); // 没配 Key：明确撤下，而不是留一个空壳 chip
      return;
    }

    const result = await fetchBalance({ candidates: balanceEndpointCandidates(baseURL), apiKey });
    this.balanceAttemptAt = Date.now(); // 失败也记：把重试节流到一个 TTL 一次
    if (epoch !== this.balanceEpoch) return; // 配置已变：这次结果作废，别把旧账号的余额写上去

    if (!result.ok) {
      // 失败**保留上一次已知值**：一次网络抖动就显示"没有余额"，比显示一个稍旧的数字更误导。
      // 具体原因进 `dsh` 输出通道；界面上的数字旁边始终带"更新于"，新旧可自行判断。
      logger.info(
        `API 余额获取失败：${result.detail}（${describeBalanceEndpoint(balanceEndpointCandidates(baseURL)[0])}）`
      );
      return;
    }

    this.pushBalance(buildBalancePayload(result.info, new Date(this.balanceAttemptAt).toLocaleTimeString()));
  }

  /**
   * 撤下余额 chip（不适用 / 未配置 / 换了账号）：推一个明确的"不可用"。
   * 不碰"最近一次尝试时间"—— 这条路径不发网络，让下一次触发重新判断的代价可忽略。
   */
  private clearBalance(epoch = this.balanceEpoch): void {
    if (epoch !== this.balanceEpoch) return;
    this.pushBalance({ available: false });
  }

  private pushBalance(payload: BalancePayload): void {
    this.balancePayload = payload;
    this.post({ kind: 'event', method: 'balance.info', params: payload });
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
   * 会话级事务回滚（P2-6）：把**本次会话**改动过的文件还原到会话开始前。
   *
   * 三个刻意的取舍：
   * ① **破坏性操作先弹模态确认**，而不是复用面板里的审批卡 —— 审批卡是"Agent 发起的、必须走的门"，
   *    回滚是用户主动发起的，用原生确认更直接，也不容易被误点。
   * ② **结论进通知栏，明细进面板**：一句话说不出"哪几个文件被跳过、为什么"，
   *    而这些恰恰决定用户下一步要做什么（去保存？去手动处理？）。
   * ③ 前置失败（daemon 未连接 / 会话正在运行）如实报出来，不降级成"点了没反应"。
   */
  async rollbackSession(): Promise<void> {
    const sessionId = this.daemon.getSessionId();
    if (!this.daemon.client.isOpen || !sessionId) {
      void vscode.window.showErrorMessage('daemon 未连接，无法回滚本次会话的改动');
      return;
    }
    const pick = await vscode.window.showWarningMessage(
      '将把本次会话改动过的文件还原到会话开始前。\n' +
        '编辑器里有未保存改动的文件会被跳过（不会覆盖你正在编辑的内容）。\n' +
        '此操作不可撤销。',
      { modal: true },
      '回滚'
    );
    if (pick !== '回滚') return;

    try {
      const report = await this.daemon.client.request<SessionRollbackResult>(METHODS.SessionRollback, {
        sessionId,
      });
      const ws = resolveWorkspaceRoot(vscode.workspace.workspaceFolders);
      const summary = formatRollbackReport(report, { workspaceRoot: ws.ok ? ws.root : undefined });
      // 明细也落日志：面板可能已经关掉，而"哪些文件没回滚成"是需要事后查的
      logger.info(`会话回滚：${summary.headline}${summary.detail ? `\n${summary.detail}` : ''}`);
      this.post({
        kind: 'event',
        method: 'notice',
        params: { text: summary.detail ? `${summary.headline}\n${summary.detail}` : summary.headline },
      });
      void vscode.window.showInformationMessage(summary.headline);
    } catch (err) {
      const code = (err as { code?: number } | null)?.code;
      const msg = err instanceof Error ? err.message : String(err);
      // Busy = 会话正在跑。这不是故障而是门禁，文案里已经写清"怎么办"，用警告而不是错误
      if (code === ERROR_CODES.Busy) {
        void vscode.window.showWarningMessage(msg);
      } else {
        void vscode.window.showErrorMessage(`回滚失败: ${msg}`);
      }
    }
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
    this.pendingPlans.clear();
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
        // 余额不放进 init 快照：它是"外部事实 + 带 TTL 的缓存"，走独立的本地事件，
        // 这样命中缓存时也能立刻补上（init 只在 surface 就绪时推一次）
        void this.refreshBalance();
        return;
      case 'send':
        await this.doSend((msg.prompt ?? '').trim(), !!msg.planMode, msg.images);
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
      case 'plan.respond': {
        if (!msg.planId) return;
        try {
          await this.daemon.client.request(METHODS.PlanRespond, {
            sessionId: this.daemon.getSessionId(),
            planId: msg.planId,
            approved: !!msg.approved,
            note: msg.note,
          });
        } catch (err) {
          const code = (err as { code?: number } | null)?.code;
          if (code === ERROR_CODES.Expired) {
            this.post({ kind: 'event', method: 'plan.expired', params: { planId: msg.planId } });
            void vscode.window.showWarningMessage('计划已过期，按不同意处理');
          } else if (code === ERROR_CODES.NotFound) {
            this.post({ kind: 'event', method: 'plan.expired', params: { planId: msg.planId } });
          } else {
            void vscode.window.showErrorMessage(
              `计划回传失败: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        } finally {
          this.pendingPlans.delete(msg.planId);
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
        this.post({
          kind: 'event',
          method: 'settings.loaded',
          params: { config, hasApiKey, ...this.modelCatalogPayload(config.model, config.baseURL, hasApiKey) },
        });
        // 在线列表在后台刷新（面板先渲染，拿到新列表再推 settings.models）：
        // 用户打开设置面板，不该为了一个下拉等一次网络往返。
        void this.refreshModelCatalog(config, hasApiKey);
        return;
      }
      case 'settings.apply': {
        const s = msg.settings ?? {};
        if (s.apiKey !== undefined) await this.configAccessor.setApiKey(s.apiKey);
        await this.configAccessor.applyPanelConfig(s);
        // 端点或 Key 变了 → 缓存的列表不再代表当前端点。清掉并立刻重拉，
        // 让还开着面板的用户当场看到"新 Key 能用、这个端点有哪些模型"。
        if (s.baseURL !== undefined || s.apiKey) {
          await this.clearCatalogCache();
          const next = this.configAccessor.getPanelConfig();
          void this.refreshModelCatalog(next, await this.configAccessor.hasApiKey());
          // 余额属于**账号**：换了 Key / 端点，旧数字必须立刻撤下再重取
          // （注意与手动刷新的差别：手动刷新不清空当前数字，见 refreshBalance）
          this.clearBalance();
          void this.refreshBalance(true);
        }
        this.post({ kind: 'event', method: 'settings.applied', params: { restartNeeded: true } });
        return;
      }
      case 'balance.refresh':
        // 点余额 chip：立刻重取（不撤下当前数字 —— 刷新失败时旧的已知值比一片空白有用）
        void this.refreshBalance(true);
        return;
      case 'ui.diag':
        // 前端渲染诊断（单条事件抛错 / 收到未知事件）。只记日志：
        // 它的价值在于"把静默失败变成可查的线索"，不该反过来打扰用户。
        logger[msg.diag?.level === 'debug' ? 'debug' : 'warn'](
          `[webview] ${msg.diag?.method ?? '(unknown)'}: ${msg.diag?.message ?? '未知事件'}`
        );
        return;
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
      case 'trust.manage':
        // 受限模式横幅的「信任此工作区」：信任由 VS Code 判定，本扩展只是把入口递过去
        await openTrustManagement();
        return;
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
    for (const [id, pl] of this.pendingPlans) {
      if (typeof pl.expiresAt === 'number' && pl.expiresAt <= now) this.pendingPlans.delete(id);
    }
    return {
      sessionId: this.daemon.getSessionId(),
      connected: this.daemon.client.isOpen,
      history: this.history.list(),
      ...this.daemon.getAgentInfo(),
      pending: {
        approvals: [...this.pendingApprovals.values()],
        patches: [...this.pendingPatches.values()],
        plans: [...this.pendingPlans.values()],
      },
      trust: resolveTrustGate(vscode.workspace.isTrusted),
    };
  }

  /**
   * 工作区信任状态变化后重新广播（与 agent.info 同一套"扩展侧本地事件"）。
   *
   * 必须单独推一次：受限模式下 daemon 不会启动，因而收不到任何握手事件，
   * 「受限模式」横幅就没有别的撤下时机（用户信任工作区后要能立刻恢复正常观感）。
   */
  notifyTrustChange(): void {
    this.post({ kind: 'event', method: 'trust.info', params: resolveTrustGate(vscode.workspace.isTrusted) });
  }

  private async doSend(
    prompt: string,
    planMode = false,
    images?: ImageAttachmentInput[]
  ): Promise<void> {
    // 图片先过校验。越限时**拒绝整条消息**而不是"丢掉那张继续发"：这类消息里的图片
    // 往往就是提问本身（"看这个报错截图"），少发一张会让模型对着一张根本不存在的图作答，
    // 而用户拿到的是一段看起来完全正常的胡话 —— 比直接报错难发现得多。
    const imageCheck = sanitizeImageAttachments(images);
    if (!imageCheck.ok) {
      void vscode.window.showErrorMessage(`图片附件：${imageCheck.reason}`);
      this.post({
        kind: 'event',
        method: EVENTS.Error,
        params: { message: `图片附件：${imageCheck.reason}` },
      });
      // 不清理面板暂存：用户删掉/换掉那一张就能直接重发
      return;
    }
    const images_ = imageCheck.images;
    // "空消息"要连同图片一起看：只粘一张截图直接发送是常见用法，要求必须凑一句文字，
    // 只会让人把图存下来再翻回去贴。
    if (!prompt && images_.length === 0) {
      void vscode.window.showWarningMessage('请输入 Prompt，或附加一张图片');
      return;
    }
    if (!this.daemon.client.isOpen) {
      // 受限模式是"为什么没连上"的确定答案：不要退化成含糊的"daemon 未连接"让用户去猜
      const gate = resolveTrustGate(vscode.workspace.isTrusted);
      void vscode.window.showErrorMessage(
        gate.blocked
          ? `${gate.statusLabel}：${gate.statusDetail}`
          : 'daemon 未连接，请检查状态栏或运行 “dsh: 查看 Daemon 状态”'
      );
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
      // 面板粘的图片排在**最前**：它是用户主动给的、直接对应问题本身，
      // 而自动捕获的上下文只是背景。顺序也决定 daemon 侧 [图片 N] 标记的位置。
      attachments = [...images_, ...attachments];
      this.post({
        kind: 'event',
        method: 'user.message',
        params: { text: prompt, attachments: summarizeAttachments(attachments), planMode: planMode || undefined },
      });
      const sessionId = this.daemon.getSessionId();
      if (sessionId) this.history.appendUser(sessionId, prompt);
      // P0-1：把"此刻的未保存缓冲区"推给 daemon，再发消息——否则 Agent 读到的磁盘内容
      // 可能落后于用户刚刚敲下的改动（去抖窗口内尚未同步）。
      await this.dirty?.syncNow();
      await this.daemon.client.request(METHODS.SessionSend, { sessionId, prompt, attachments, planMode });
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
    const read = (file: string) => fs.readFileSync(path.join(mediaDir, file), 'utf8');
    // 脚本仍走资源 URI（webview 里脚本靠 nonce 放行，本就不依赖 URL 匹配），
    // 但挂上内容指纹：资源加载器按 URI 缓存，而扩展安装路径只随版本号变化，
    // 不挂指纹的话在 F5 开发态下 rebuild 会一直命中旧 bundle。
    const jsUri =
      webview
        .asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'out', 'media', 'webview.js'))
        .toString() + `?v=${fileStamp(path.join(mediaDir, 'webview.js'))}`;
    // 样式走内联（见 media/webview.html 顶部的说明）：外部样式表只能靠 CSP 的
    // URL 匹配放行，而资源 URI 带百分号编码的盘符路径，匹配不上就整体被拦，
    // 症状是"脚本正常、界面完全没样式"。内联后不经过 URL 匹配，也不吃资源缓存。
    return renderWebviewHtml(read('webview.html'), {
      nonce: requireCryptoRandom(),
      css: read('webview.css'),
      cspSource: webview.cspSource,
      jsUri,
    });
  }
}

/**
 * 把捕获到的附件折叠为 UI chip 文案，让用户一眼看到 Agent 实际拿到了什么上下文。
 * 只做展示，不影响发送给 daemon 的原始附件。
 */
function summarizeAttachments(attachments: Attachment[]): { label: string; imageId?: string }[] {
  const chips: { label: string; imageId?: string }[] = [];
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
      case 'image':
        // 只回传 clientId，**不回传 base64**：缩略图数据本来就在面板手里，
        // 来回搬一趟等于把几 MB 的图片复制进消息桥与 DOM。
        chips.push({
          label: `🖼 ${a.name || '图片'}${a.sizeBytes ? `（${(a.sizeBytes / 1024).toFixed(0)} KB）` : ''}`,
          ...(a.clientId ? { imageId: a.clientId } : {}),
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

/**
 * 资源内容指纹（FNV-1a 32 位十六进制），用于 webview 资源 URI 的缓存击穿。
 * 不引 crypto：这里只需要"内容一变指纹就变"，不需要密码学强度；
 * 一次 webview 创建只算一次，几万字节的开销可忽略。
 */
function fileStamp(absPath: string): string {
  try {
    const buf = fs.readFileSync(absPath);
    let h = 0x811c9dc5;
    for (let i = 0; i < buf.length; i++) {
      h = Math.imul(h ^ buf[i], 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  } catch {
    // 读不到就退化成每次都变的时间戳：宁可多拉一次资源，也不要发出旧的
    return String(Date.now());
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
