/**
 * dsh 参考 daemon：WebSocket/JSON-RPC 服务端。
 *
 * 安全设计（对应方案"工程化核心关注点"）：
 *  - 仅绑定 127.0.0.1（默认随机端口）
 *  - 打开握手必须携带 `Authorization: Bearer <token>`（verifyClient 校验）
 *  - 拒绝来自浏览器 Origin 的连接（防跨站 WebSocket 劫持 CSWSH）
 *  - token 通过环境变量/启动参数传入，不写盘（可选 --port-file 只写端口）
 *
 * P1 加固：
 *  - 会话状态机 + 事件缓冲（session.resume 断线续跑）
 *  - 审批/补丁强校验（归属 + expiresAt 过期拒绝）
 *  - 路径护栏（patch / file.read 目标必须位于工作区 / allowedDirs 内）
 *  - 能力分级（allowedTools / allowedDirs / maxConcurrency）
 *  - 多会话并发（同一会话串行，不同会话并行）
 *
 * P2-6 会话级事务回滚：
 *  - 写盘 / 改编辑器之前留影子快照（`.dsh/snapshots/<会话>/`），`session.rollback` 一键还原
 *  - 运行中的会话拒绝回滚；编辑器里有未保存改动的文件一律跳过并如实回报
 */
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { WebSocket, WebSocketServer, RawData } from 'ws';
import {
  EVENTS,
  ERROR_CODES,
  isJsonRpcNotification,
  isJsonRpcRequest,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  METHODS,
  InitializeParams,
  InitializeResult,
  EventApprovalRequest,
  EventFilePatchPending,
  EventPlanRequest,
  EventTrajectory,
  PlanRespondParams,
  SessionSendParams,
  SessionRollbackParams,
  SessionRollbackResult,
  WorkspaceSyncDirtyParams,
} from '../../shared/protocol';
import { AgentContext, runFakeAgent } from './agent';
import { DirtyOverlay } from './dirtyOverlay';
import { ChatModel, createKeywordFakeModel, createModel as createProviderModel, withRetry } from './model';
import { RealAgentConfig, runRealAgent } from './realAgent';
import { DEFAULT_APPROVAL_TTL_MS, Session, SessionManager } from './sessionManager';
import {
  defaultCapabilities,
  HandshakeInfo,
  normalizeDeclaration,
  NormalizedCapabilities,
  pendingRespondError,
  resolvePathWithin,
  verifyHandshake,
} from './serverGuards';
import { SessionSnapshotStore } from './sessionSnapshot';
import { TrajectoryStore } from './trajectoryStore';
import { VSD_DSH_VERSION } from '../../shared/version';
import { readBuildId } from '../../shared/buildId';
import { TrustStore } from './trust';
import { detectSandbox } from './sandbox';

export interface DaemonServerOptions {
  token: string;
  workspaceRoot: string;
  preset?: string;
  apiKey?: string;
  port?: number;
  /** Agent 实现：mock | real | auto（缺省） */
  agent?: 'mock' | 'real' | 'auto';
  /** 模型 provider（P3.5+）：openai | anthropic | auto（缺省） */
  provider?: 'openai' | 'anthropic' | 'auto';
  /** 集成冒烟：agent=real 时用关键字假模型（不起网络） */
  fakeModel?: boolean;
  /** 端口就绪后回调（随机端口时用于上报） */
  onPort?: (port: number) => void;
}

export interface DaemonServerHandle {
  port: number;
  close(): Promise<void>;
}

const MAX_READ_BYTES = 1024 * 1024; // file.read 单文件上限 1MB

/** 模型运行时配置（CLI 缺省 + initialize 覆盖；P0-4 后为连接级）。 */
export interface RuntimeConfig {
  apiKey: string;
  preset?: string;
  baseURL: string;
  model: string;
  agent: 'mock' | 'real' | 'auto';
  provider: 'openai' | 'anthropic' | 'auto';
  /** 模型请求空闲超时（ms，P0-3）；undefined = 用模型层缺省（60s）；<= 0 关闭 */
  idleTimeoutMs?: number;
  /** Agent 循环预算（P2-2）：工具调用轮数上限 / 上下文 token 预算；undefined = 用协议缺省 */
  maxToolRounds?: number;
  maxContextTokens?: number;
  /** 采样温度（0–2）；undefined = 用模型层缺省（0.2），即不改动既有行为 */
  temperature?: number;
  /** 单次输出上限（max_tokens）；undefined / <= 0 = 不发送该字段，由服务端决定 */
  maxTokens?: number;
}

/**
 * 连接级运行状态（P0-4 下沉）。
 *
 * capabilities / approvalTtlMs / 模型配置原先定义在**服务实例**作用域，而 daemon 可被同一
 * 工作区的多个 VSCode 窗口复用（auto 探测复用 .dsh/daemon.json）——最后一个 initialize 会
 * 整体覆盖所有人，导致 A 窗口声明的 allowedTools 白名单被 B 窗口的空配置冲掉，安全语义被
 * 跨窗口静默污染。现改为每个 WebSocket 连接各持一份，互不影响。
 */
export interface ConnectionRuntime {
  capabilities: NormalizedCapabilities;
  approvalTtlMs: number;
  runtime: RuntimeConfig;
}

/**
 * Agent 实现决策：模式 + （mock 时）成因。
 *
 * 成因必须显式回报给前端，否则"没配 Key → 静默降级成 mock"用户无法察觉
 * （他会以为关键字模拟循环的回复是真模型的回答）。见 `InitializeResult.agentReason`。
 */
export interface AgentDecision {
  mode: 'mock' | 'real';
  reason?: 'no-api-key' | 'forced-mock';
}

/** 解析最终生效的 Agent 实现：显式 real/mock 优先，auto 时以是否有 apiKey 决定。 */
export function resolveAgentDecision(rt: RuntimeConfig): AgentDecision {
  if (rt.agent === 'real') return { mode: 'real' };
  if (rt.agent === 'mock') return { mode: 'mock', reason: 'forced-mock' };
  return rt.apiKey ? { mode: 'real' } : { mode: 'mock', reason: 'no-api-key' };
}

/** 只需要模式时的便捷入口（与 resolveAgentDecision 同源，不会漂移）。 */
export function resolveAgentMode(rt: RuntimeConfig): 'mock' | 'real' {
  return resolveAgentDecision(rt).mode;
}

/** 连接级运行状态初值：以 CLI 参数为缺省，等待该连接的 initialize 覆盖。 */
export function createConnectionRuntime(opts: DaemonServerOptions): ConnectionRuntime {
  return {
    capabilities: defaultCapabilities(),
    approvalTtlMs: DEFAULT_APPROVAL_TTL_MS,
    runtime: {
      apiKey: opts.apiKey ?? '',
      preset: opts.preset,
      baseURL: '',
      model: '',
      agent: opts.agent ?? 'auto',
      provider: opts.provider ?? 'auto',
    },
  };
}

export async function startDaemonServer(opts: DaemonServerOptions): Promise<DaemonServerHandle> {
  const sessions = new SessionManager(opts.workspaceRoot);
  const trajectoryStore = new TrajectoryStore(path.join(opts.workspaceRoot, '.dsh', 'trajectory'));
  // B1 信任记忆：免审批白名单，持久化于 <workspace>/.dsh/trust.json（0600，用户可审阅/删除）
  const trustStore = new TrustStore({ file: path.join(opts.workspaceRoot, '.dsh', 'trust.json') });
  // P2-6 会话级事务回滚：影子快照落在 <workspace>/.dsh/snapshots/<会话>/（0700 / 0600）
  const snapshots = new SessionSnapshotStore({
    root: path.join(opts.workspaceRoot, '.dsh', 'snapshots'),
    workspaceRoot: opts.workspaceRoot,
  });
  // P3.5+ 命令沙箱：检测 OS 级后端（Linux bwrap），不可用则应用层兜底；降级原因经 warnings 披露
  const { sandbox, warnings } = detectSandbox(opts.workspaceRoot);
  if (warnings.length > 0) console.warn(`[dsh-daemon] 命令沙箱：${warnings.join('；')}`);

  /**
   * 依据连接级运行时配置创建真实模型（auto 切换 + 集成假模型）。
   *
   * 真实模型统一套一层「瞬时失败自动重试」：一次网络抖动或 429 不该让整场会话直接中断
   * （实测会话失败中两次在 ~110ms 内返回、19 秒后同一请求即成功）。假模型不套：确定性、无网络。
   */
  function createModel(rt: RuntimeConfig): ChatModel {
    if (opts.fakeModel) return createKeywordFakeModel();
    return withRetry(
      createProviderModel({
        provider: rt.provider,
        baseURL: rt.baseURL || undefined,
        apiKey: rt.apiKey,
        model: rt.model || undefined,
      })
    );
  }

  const server = http.createServer((_req, res) => {
    // 非升级（非 WebSocket）请求一律拒绝，且**不回任何可识别内容**。
    //
    // 此前这里对任意 GET 都回 `200 dsh daemon (reference implementation)` —— 等于给了本机
    // 任意进程一个"这个端口上跑着 dsh daemon、版本几何"的确认信号（端口探测/指纹识别）。
    // 该端口只为 WS 升级存在，没有任何合法的普通 HTTP 用途，故直接 404 + 空正文：
    // 用 404 而非 426 是有意的 —— 426 会带上 `Upgrade: websocket`，仍然确认了"这是个 WS 端点"，
    // 而这里要的正是"什么都别泄露"。
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' });
    res.end();
  });

  const wss = new WebSocketServer({
    server,
    host: '127.0.0.1',
    verifyClient: (info: { origin: string; req: http.IncomingMessage }) => {
      // 判定本身抽到 serverGuards.verifyHandshake（P1-17）：那里能离线穷举 token/Origin 边界，
      // 这里只负责把 ws 给的两处来源摘成 HandshakeInfo（origin 缺失时回落请求头）。
      const hs: HandshakeInfo = {
        authorization: info.req.headers.authorization,
        origin: info.origin ?? info.req.headers.origin,
      };
      return verifyHandshake(hs, opts.token);
    },
  });

  interface Connection extends ConnectionRuntime {
    ws: WebSocket;
    /** 当前默认会话 id（session.send 未指定时使用） */
    currentSessionId: string;
    /**
     * P0-1 脏文档覆盖层：客户端推来的「编辑器未保存缓冲区」快照。
     * 连接级（与 capabilities 同理）：daemon 可能被多个窗口复用，各窗口打开的文档集合不同，
     * 覆盖层必须随连接隔离，否则 A 窗口的未保存内容会污染 B 窗口的读取结果。
     */
    dirty: DirtyOverlay;
    notify(method: string, params: unknown): void;
  }

  const connections = new Set<Connection>();

  wss.on('connection', (ws: WebSocket) => {
    const conn: Connection = {
      ...createConnectionRuntime(opts),
      ws,
      currentSessionId: '',
      dirty: new DirtyOverlay(),
      notify(method, params) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
        }
      },
    };

    connections.add(conn);

    ws.on('message', (data: RawData) => {
      let msg: unknown;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        sendError(ws, null, ERROR_CODES.ParseError, 'Parse error');
        return;
      }
      handleMessage(conn, msg);
    });

    ws.on('close', () => {
      connections.delete(conn);
    });
  });

  /** 把会话的事件投递绑定到当前连接（resume 时覆盖旧连接）。 */
  function attach(conn: Connection, session: Session): void {
    session.deliver = (method, params) => conn.notify(method, params);
    conn.currentSessionId = session.id;
  }

  /**
   * 校验目标路径位于工作区（canonical：解析符号链接/联结）且位于**该连接**声明的 allowedDirs 内。
   * capabilities 为连接级（P0-4），因此必须由调用方传入，不可读实例状态。
   */
  function resolvePath(
    caps: NormalizedCapabilities,
    target: string
  ): { resolved: string } | { error: string } {
    // 双重约束（工作区 + allowedDirs）抽到 serverGuards.resolvePathWithin（P1-17），此处只注入本实例的工作区根
    return resolvePathWithin(opts.workspaceRoot, caps.allowedDirs, target);
  }

  /**
   * P0-1：读取「用户实际看到的内容」——脏文档覆盖层优先，未命中回落磁盘。
   *
   * `resolved` 必须是 canonical 路径（resolvePath / resolveTarget 的产物），否则覆盖层查不到：
   * 覆盖层的键与护栏产出的 canonical 路径同源（都过 `pathKey`）。
   *
   * `dirty` 的含义严格限定为「**内容取自覆盖层**」；超大文件只上报脏状态、不上报内容，
   * 此时回落磁盘且 dirty 为 false（写入安全由 `conn.dirty.has()` 单独保证，与其无关）。
   */
  function readEffective(
    conn: Connection,
    resolved: string
  ): { content: string; dirty: boolean } | undefined {
    const overlay = conn.dirty.get(resolved);
    if (overlay !== undefined) return { content: overlay, dirty: true };
    try {
      return { content: fs.readFileSync(resolved, 'utf8'), dirty: false };
    } catch {
      return undefined;
    }
  }

  function handleMessage(conn: Connection, msg: unknown): void {
    if (isJsonRpcRequest(msg)) {
      void handleRequest(conn, msg);
    } else if (isJsonRpcNotification(msg)) {
      handleNotification(conn, msg);
    } else {
      const maybeId = (msg as { id?: number | string } | null)?.id;
      sendError(conn.ws, maybeId ?? null, ERROR_CODES.InvalidRequest, 'Invalid Request');
    }
  }

  async function handleRequest(conn: Connection, req: JsonRpcRequest): Promise<void> {
    try {
      switch (req.method) {
        case METHODS.Initialize: {
          const p = req.params as InitializeParams;
          if (!p || !p.workspaceRoot) {
            sendError(conn.ws, req.id, ERROR_CODES.InvalidParams, 'initialize 需要 workspaceRoot');
            return;
          }
          // 能力分级：**本连接**声明、本连接执行（P0-4：不再污染其他窗口/连接）。
          // 收敛（字段类型校验 + TTL 钳制）在 serverGuards.normalizeDeclaration，见 P1-17。
          const decl = normalizeDeclaration(p.capabilities);
          conn.capabilities = decl.capabilities;
          // 挂起项超时（审批 / 计划 / 补丁）：仅客户端**显式声明**时才覆盖，否则保持现状
          if (decl.approvalTtlMs !== null) conn.approvalTtlMs = decl.approvalTtlMs;
          // 模型配置合并（CLI 缺省 < initialize 顶层 apiKey/preset < initialize.model）
          const rt = conn.runtime;
          if (p.apiKey) rt.apiKey = p.apiKey;
          if (p.preset) rt.preset = p.preset;
          if (p.model?.apiKey) rt.apiKey = p.model.apiKey;
          if (p.model?.baseURL) rt.baseURL = p.model.baseURL;
          if (p.model?.model) rt.model = p.model.model;
          if (p.model?.agent) rt.agent = p.model.agent;
          if (p.model?.provider) rt.provider = p.model.provider;
          if (p.model?.idleTimeoutMs !== undefined) rt.idleTimeoutMs = p.model.idleTimeoutMs;
          // Agent 循环预算（P2-2）：区间合法性在扩展侧写入配置时就已收敛，这里只做透传
          if (p.model?.maxToolRounds !== undefined) rt.maxToolRounds = p.model.maxToolRounds;
          if (p.model?.maxContextTokens !== undefined) rt.maxContextTokens = p.model.maxContextTokens;
          // 采样参数（批次 2）：undefined 一律视为"用户没配" —— 温度继续走模型层缺省 0.2，
          // 上限继续不发送；只有显式配置才改变请求体。
          if (p.model?.temperature !== undefined) rt.temperature = p.model.temperature;
          if (p.model?.maxTokens !== undefined) rt.maxTokens = p.model.maxTokens;
          const session = sessions.create();
          attach(conn, session);
          // 显式回报「为什么是 mock」，让前端能提示"演示模式"而不是静默降级
          const decision = resolveAgentDecision(rt);
          const result: InitializeResult = {
            daemonVersion: VSD_DSH_VERSION,
            buildId: readBuildId(),
            protocolVersion: '1.0',
            capabilities: {
              streaming: true,
              approvals: true,
              filePatches: true,
              sessions: true,
              trajectory: true,
              resume: true,
              fileRead: true,
              rollback: true,
              plan: true,
              image: true,
            },
            sessionId: session.id,
            agent: decision.mode,
            agentReason: decision.reason,
          };
          sendResult(conn.ws, req.id, result);
          return;
        }
        case METHODS.SessionCreate: {
          const session = sessions.create();
          attach(conn, session);
          sendResult(conn.ws, req.id, { sessionId: session.id });
          return;
        }
        case METHODS.SessionSend: {
          const p = req.params as SessionSendParams;
          if (!p || typeof p.prompt !== 'string') {
            sendError(conn.ws, req.id, ERROR_CODES.InvalidParams, 'session.send 需要 prompt');
            return;
          }
          const session = sessions.get(p.sessionId ?? conn.currentSessionId);
          if (!session) {
            sendError(conn.ws, req.id, ERROR_CODES.NotFound, `session 不存在: ${p.sessionId ?? conn.currentSessionId}`);
            return;
          }
          if (!session.canStart()) {
            sendError(conn.ws, req.id, ERROR_CODES.Busy, `session ${session.id} 正在运行中，请先取消或等待完成`);
            return;
          }
          const maxConcurrency = conn.capabilities.maxConcurrency;
          if (maxConcurrency > 0 && sessions.runningCount() >= maxConcurrency) {
            sendError(conn.ws, req.id, ERROR_CODES.Busy, `并发会话数已达上限 ${maxConcurrency}`);
            return;
          }
          session.begin();
          attach(conn, session);
          sendResult(conn.ws, req.id, { sessionId: session.id, accepted: true });

          const ctx: AgentContext = {
            sessionId: session.id,
            workspaceRoot: opts.workspaceRoot,
            capabilities: conn.capabilities,
            notify: (method, params) => {
              // 挂起类事件由 daemon 统一盖章过期时间：TTL 只有一个来源（initialize 声明 / 缺省 60s），
              // 避免 Agent 各自硬编码，同时让 UI 能显示真实倒计时。
              if (
                method === EVENTS.ApprovalRequest ||
                method === EVENTS.FilePatchPending ||
                method === EVENTS.PlanRequest
              ) {
                const p = params as { expiresAt?: number };
                if (p && typeof p === 'object' && p.expiresAt === undefined) {
                  p.expiresAt = Date.now() + conn.approvalTtlMs;
                }
              }
              session.emit(method, params);
              // 轨迹持久化（P3.4）：仅 trajectory.record 事件落盘
              if (method === EVENTS.Trajectory) {
                trajectoryStore.append(session.id, params as EventTrajectory);
              }
            },
            waitForUser: (kind, snapshot) => {
              if (kind === 'approval') {
                return session.registerApproval(snapshot as EventApprovalRequest, conn.approvalTtlMs);
              }
              if (kind === 'plan') {
                return session.registerPlan(snapshot as EventPlanRequest, conn.approvalTtlMs);
              }
              return session.registerPatch(snapshot as EventFilePatchPending, conn.approvalTtlMs);
            },
            isCanceled: () => session.isCanceled(),
            // P1-8：步号来自会话而不是模块级全局，多会话并发时迹线步号才连续
            nextStep: () => session.nextStep(),
            // P0-3：把「会话被取消」同步转达给 Agent，使在途模型请求能被立即 abort，
            // 而不是等下一个 onChunk 才察觉（模型静默时 onChunk 永不触发）。
            onCancel: (fn) => session.onCancel(fn),
            isTrusted: (command) => trustStore.matches(command),
            // P2-7：用户在批准计划时附带的补充意见（透传给执行阶段的指令）
            getPlanNote: () => session.getPlanNote(),
            getPatchContent: (patchId) => session.getPatchContent(patchId),
            readFile: async (target, maxBytes) => {
              const r = resolvePath(conn.capabilities, target);
              if ('error' in r) return undefined;
              const eff = readEffective(conn, r.resolved);
              if (!eff) return undefined;
              const cap = maxBytes ?? MAX_READ_BYTES;
              return eff.content.length > cap ? eff.content.slice(0, cap) + '\n…[truncated]' : eff.content;
            },
            // P0-1：目标是否处于「编辑器未保存」状态（供 agent 给输出加标注）
            isDirty: (target) => {
              const r = resolvePath(conn.capabilities, target);
              return 'error' in r ? false : conn.dirty.has(r.resolved);
            },
            // P0-1：本补丁是否已由客户端应用到编辑器缓冲区（为 true 时 agent 不写盘）
            isPatchAppliedInEditor: (patchId) => session.getPatchApplyInEditor(patchId),
            // P2-6 会话回滚：改动发生**之前**留一份影子快照（改动前内容首写优先、写入指纹末次覆盖、不抛）
            recordSnapshot: (resolvedPath, originalContent, writtenContent) =>
              snapshots.record(session.id, resolvedPath, originalContent, writtenContent),
          };
          // P3.6：auto 切换 —— 有 apiKey（或显式 real）走真实模型，否则回退内置模拟
          const agentMode = resolveAgentMode(conn.runtime);
          if (agentMode === 'real') {
            const model = createModel(conn.runtime);
            const agentConfig: RealAgentConfig = {
              model,
              sandbox,
              idleTimeoutMs: conn.runtime.idleTimeoutMs,
              // P2-2：轮次与上下文预算来自连接级运行时配置（扩展经 initialize 下发）；
              // 未配置时留 undefined，由 realAgent 用协议缺省兜底。
              maxToolRounds: conn.runtime.maxToolRounds,
              maxContextTokens: conn.runtime.maxContextTokens,
              temperature: conn.runtime.temperature,
              maxTokens: conn.runtime.maxTokens,
            };
            void runRealAgent(ctx, p, agentConfig).finally(() => {
              session.end();
              // 会话结束时立即落盘轨迹缓冲（审计完整性，不等定时器）
              trajectoryStore.flush();
            });
          } else {
            void runFakeAgent(ctx, p).finally(() => {
              session.end();
              trajectoryStore.flush();
            });
          }
          return;
        }
        case METHODS.SessionCancel: {
          const p = req.params as { sessionId?: string } | undefined;
          const session = sessions.get(p?.sessionId ?? conn.currentSessionId);
          if (session) {
            session.cancel();
          }
          sendResult(conn.ws, req.id, { canceled: !!session });
          return;
        }
        case METHODS.SessionResume: {
          const p = req.params as { sessionId: string };
          const session = sessions.get(p?.sessionId ?? '');
          if (!session) {
            sendError(conn.ws, req.id, ERROR_CODES.NotFound, `session 不存在: ${p?.sessionId}`);
            return;
          }
          attach(conn, session);
          const result = session.resume();
          sendResult(conn.ws, req.id, result);
          return;
        }
        case METHODS.SessionRollback: {
          // P2-6：把本次会话改动过的文件还原到会话开始前（影子快照见 sessionSnapshot.ts）
          const p = req.params as SessionRollbackParams | undefined;
          const session = sessions.get(p?.sessionId ?? conn.currentSessionId);
          if (!session) {
            sendError(
              conn.ws,
              req.id,
              ERROR_CODES.NotFound,
              `session 不存在: ${p?.sessionId ?? conn.currentSessionId}`
            );
            return;
          }
          // 运行中的会话禁止回滚：Agent 正在写文件，与还原并发只会得到"刚还回去又被改掉"的
          // 混乱状态。宁可让用户先取消 / 等这轮结束，也不要执行一次语义不完整的回滚。
          if (!session.canStart()) {
            sendError(
              conn.ws,
              req.id,
              ERROR_CODES.Busy,
              `session ${session.id} 正在运行中，请先取消或等待本轮结束后再回滚`
            );
            return;
          }
          // 脏文档判定走**本连接**的覆盖层（与写盘侧同源）：文件此刻在编辑器里有未保存改动
          // 就一律跳过，绝不覆盖用户正在编辑的内容。
          const result: SessionRollbackResult = snapshots.restore(session.id, (resolved) =>
            conn.dirty.has(resolved)
          );
          console.log(
            `[rollback] 会话 ${session.id}：还原 ${result.restored.length}、删除 ${result.deleted.length}、` +
              `脏跳过 ${result.skippedDirty.length}、内容已变 ${result.changedAfter.length}、` +
              `不可还原 ${result.unrestorable.length}、失败 ${result.failed.length}` +
              `${result.unrecorded > 0 ? `、未记录 ${result.unrecorded}` : ''}`
          );
          sendResult(conn.ws, req.id, result);
          return;
        }
        case METHODS.ApprovalRespond: {
          const p = req.params as {
            sessionId?: string;
            approvalId: string;
            approved: boolean;
            trust?: boolean;
          };
          const session = sessions.get(p?.sessionId ?? conn.currentSessionId);
          if (!session) {
            sendError(conn.ws, req.id, ERROR_CODES.NotFound, 'session 不存在');
            return;
          }
          // B1 信任记忆：批准并记住 -> 先把命令纳入白名单，再完成审批
          if (p?.trust && p?.approved) {
            const input = session.getPendingApprovalInput();
            const command = String(input?.command ?? input?.cmd ?? '').trim();
            if (command) {
              trustStore.add(command);
              console.log(`[trust] 审批通过并记住了命令规则：${command}`);
            }
          }
          const r = session.respondApproval(p?.approvalId ?? '', !!p?.approved);
          // 挂起项失败码映射集中在 serverGuards.pendingRespondError（P1-17）
          const approvalErr = pendingRespondError('approval', r, p?.approvalId ?? '');
          if (approvalErr) {
            sendError(conn.ws, req.id, approvalErr.code, approvalErr.message);
            return;
          }
          sendResult(conn.ws, req.id, { ok: true });
          return;
        }
        case METHODS.PlanRespond: {
          const p = req.params as PlanRespondParams | undefined;
          const session = sessions.get(p?.sessionId ?? conn.currentSessionId);
          if (!session) {
            sendError(conn.ws, req.id, ERROR_CODES.NotFound, 'session 不存在');
            return;
          }
          const r = session.respondPlan(p?.planId ?? '', !!p?.approved, p?.note);
          const planErr = pendingRespondError('plan', r, p?.planId ?? '');
          if (planErr) {
            sendError(conn.ws, req.id, planErr.code, planErr.message);
            return;
          }
          sendResult(conn.ws, req.id, { ok: true });
          return;
        }
        case METHODS.TrustList: {
          sendResult(conn.ws, req.id, { rules: trustStore.list() });
          return;
        }
        case METHODS.TrustClear: {
          trustStore.clear();
          console.log('[trust] 信任规则已全部清空');
          sendResult(conn.ws, req.id, { ok: true });
          return;
        }
        case METHODS.TrajectoryList: {
          // C3：以协议回放持久化轨迹（脱敏、已落盘），替代直接读 .dsh/trajectory/*.jsonl
          const p = req.params as { sessionId?: string };
          const records = p?.sessionId ? trajectoryStore.read(p.sessionId) : [];
          sendResult(conn.ws, req.id, { records });
          return;
        }
        case METHODS.FilePatchRespond: {
          const p = req.params as {
            sessionId?: string;
            patchId: string;
            accept: boolean;
            content?: string;
            applyInEditor?: boolean;
          };
          const session = sessions.get(p?.sessionId ?? conn.currentSessionId);
          if (!session) {
            sendError(conn.ws, req.id, ERROR_CODES.NotFound, 'session 不存在');
            return;
          }
          // P0-1：applyInEditor = 客户端已把改动写进编辑器缓冲区，agent 侧据此跳过落盘
          const r = session.respondPatch(p?.patchId ?? '', !!p?.accept, p?.content, !!p?.applyInEditor);
          const patchErr = pendingRespondError('patch', r, p?.patchId ?? '');
          if (patchErr) {
            sendError(conn.ws, req.id, patchErr.code, patchErr.message);
            return;
          }
          sendResult(conn.ws, req.id, { ok: true });
          return;
        }
        case METHODS.FileRead: {
          const p = req.params as { path: string; maxBytes?: number };
          const r = resolvePath(conn.capabilities, p?.path ?? '');
          if ('error' in r) {
            sendError(conn.ws, req.id, ERROR_CODES.PathOutsideWorkspace, r.error);
            return;
          }
          try {
            // P0-1：脏文档优先——用户未保存时的磁盘内容已过期，读到旧版本会让 Agent 误判
            const eff = readEffective(conn, r.resolved);
            if (!eff) throw new Error('文件不存在或不可读');
            const cap = p.maxBytes ?? MAX_READ_BYTES;
            const truncated = eff.content.length > cap;
            sendResult(conn.ws, req.id, {
              content: truncated ? eff.content.slice(0, cap) : eff.content,
              truncated,
              size: Buffer.byteLength(eff.content, 'utf8'),
              dirty: eff.dirty,
            });
          } catch (e) {
            sendError(conn.ws, req.id, ERROR_CODES.InternalError, `读取失败: ${e instanceof Error ? e.message : String(e)}`);
          }
          return;
        }
        case METHODS.WorkspaceSyncDirty: {
          // P0-1：客户端推来「当前全部脏文档」全量快照，整体替换本连接的覆盖层
          const p = req.params as WorkspaceSyncDirtyParams | undefined;
          const count = conn.dirty.replace(p?.files ?? []);
          sendResult(conn.ws, req.id, { ok: true, count });
          return;
        }
        case METHODS.Ping:
          sendResult(conn.ws, req.id, { pong: Date.now() });
          return;
        case METHODS.Shutdown:
          sendResult(conn.ws, req.id, { bye: true });
          setTimeout(() => {
            server.close();
          }, 50);
          return;
        default:
          sendError(conn.ws, req.id, ERROR_CODES.MethodNotFound, `Method not found: ${req.method}`);
      }
    } catch (err) {
      sendError(conn.ws, req.id, ERROR_CODES.InternalError, err instanceof Error ? err.message : String(err));
    }
  }

  function handleNotification(conn: Connection, note: JsonRpcNotification): void {
    // 参考实现暂不需要客户端通知；预留扩展点
    void conn;
    void note;
  }

  function sendResult(ws: WebSocket, id: number | string, result: unknown): void {
    const msg: JsonRpcResponse = { jsonrpc: '2.0', id, result };
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  function sendError(ws: WebSocket, id: number | string | null, code: number, message: string): void {
    const msg: JsonRpcResponse = { jsonrpc: '2.0', id, error: { code, message } };
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  await new Promise<void>((resolve) => {
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : (opts.port ?? 0);
  opts.onPort?.(port);

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of connections) {
          c.ws.close();
        }
        wss.close(() => {
          server.close(() => resolve());
        });
        setTimeout(resolve, 500);
      }).finally(() => {
        // 落盘残留的轨迹缓冲，避免进程退出丢失审计记录
        trajectoryStore.close();
      }),
  };
}
