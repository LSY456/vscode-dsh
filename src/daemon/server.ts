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
  EventTrajectory,
  SessionSendParams,
} from '../../shared/protocol';
import { AgentCapabilities, AgentContext, runFakeAgent } from './agent';
import { ChatModel, createKeywordFakeModel, OpenAICompatibleModel } from './model';
import { assertPathInside } from './paths';
import { RealAgentConfig, runRealAgent } from './realAgent';
import { Session, SessionManager } from './sessionManager';
import { TrajectoryStore } from './trajectoryStore';
import { VSD_DSH_VERSION } from '../../shared/version';
import { readBuildId } from '../../shared/buildId';

export interface DaemonServerOptions {
  token: string;
  workspaceRoot: string;
  preset?: string;
  apiKey?: string;
  port?: number;
  /** Agent 实现：mock | real | auto（缺省） */
  agent?: 'mock' | 'real' | 'auto';
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

export async function startDaemonServer(opts: DaemonServerOptions): Promise<DaemonServerHandle> {
  const sessions = new SessionManager(opts.workspaceRoot);
  const trajectoryStore = new TrajectoryStore(path.join(opts.workspaceRoot, '.dsh', 'trajectory'));
  let capabilities: Required<AgentCapabilities> & { maxConcurrency: number } = {
    allowedTools: [],
    allowedDirs: [],
    maxConcurrency: 0,
  };
  // 模型运行时配置（CLI 缺省 + 最后一次 initialize 覆盖）
  const runtime = {
    apiKey: opts.apiKey ?? '',
    preset: opts.preset,
    baseURL: '',
    model: '',
    agent: opts.agent ?? 'auto',
  };

  /** 解析最终生效的 Agent 实现。 */
  function resolveAgentMode(): 'mock' | 'real' {
    if (runtime.agent === 'real') return 'real';
    if (runtime.agent === 'mock') return 'mock';
    return runtime.apiKey ? 'real' : 'mock';
  }

  /** 依据运行时配置创建真实模型（auto 切换 + 集成假模型）。 */
  function createModel(): ChatModel {
    if (opts.fakeModel) return createKeywordFakeModel();
    return new OpenAICompatibleModel({
      baseURL: runtime.baseURL || undefined,
      apiKey: runtime.apiKey,
      model: runtime.model || undefined,
    });
  }

  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('dsh daemon (reference implementation)\n');
  });

  const wss = new WebSocketServer({
    server,
    host: '127.0.0.1',
    verifyClient: (info: { origin: string; req: http.IncomingMessage }) => {
      // 1) Bearer token 校验
      const auth = info.req.headers.authorization ?? '';
      const okToken = auth === `Bearer ${opts.token}`;
      // 2) 浏览器 Origin 拒绝（扩展宿主不携带 Origin）
      const origin = info.origin ?? info.req.headers.origin;
      if (origin) {
        return false;
      }
      return okToken;
    },
  });

  interface Connection {
    ws: WebSocket;
    /** 当前默认会话 id（session.send 未指定时使用） */
    currentSessionId: string;
    notify(method: string, params: unknown): void;
  }

  const connections = new Set<Connection>();

  wss.on('connection', (ws: WebSocket) => {
    const conn: Connection = {
      ws,
      currentSessionId: '',
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

  /** 校验目标路径位于工作区（canonical：解析符号链接/联结）且位于 allowedDirs 内。 */
  function resolvePath(target: string): { resolved: string } | { error: string } {
    try {
      const resolved = assertPathInside(opts.workspaceRoot, target);
      if (capabilities.allowedDirs.length > 0) {
        const ok = capabilities.allowedDirs.some((d) => {
          try {
            assertPathInside(d, resolved);
            return true;
          } catch {
            return false;
          }
        });
        if (!ok) {
          return { error: `路径越界：${target} 不在 allowedDirs ${capabilities.allowedDirs.join(', ')} 内` };
        }
      }
      return { resolved };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
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
          // 能力分级：最后一次 initialize 生效（参考实现为实例级）
          capabilities = {
            allowedTools: p.capabilities?.allowedTools ?? [],
            allowedDirs: p.capabilities?.allowedDirs ?? [],
            maxConcurrency: p.capabilities?.maxConcurrency ?? 0,
          };
          // 模型配置合并（CLI 缺省 < initialize 顶层 apiKey/preset < initialize.model）
          if (p.apiKey) runtime.apiKey = p.apiKey;
          if (p.preset) runtime.preset = p.preset;
          if (p.model?.apiKey) runtime.apiKey = p.model.apiKey;
          if (p.model?.baseURL) runtime.baseURL = p.model.baseURL;
          if (p.model?.model) runtime.model = p.model.model;
          if (p.model?.agent) runtime.agent = p.model.agent;
          const session = sessions.create();
          attach(conn, session);
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
            },
            sessionId: session.id,
            agent: resolveAgentMode(),
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
          if (capabilities.maxConcurrency > 0 && sessions.runningCount() >= capabilities.maxConcurrency) {
            sendError(
              conn.ws,
              req.id,
              ERROR_CODES.Busy,
              `并发会话数已达上限 ${capabilities.maxConcurrency}`
            );
            return;
          }
          session.begin();
          attach(conn, session);
          sendResult(conn.ws, req.id, { sessionId: session.id, accepted: true });

          const ctx: AgentContext = {
            sessionId: session.id,
            workspaceRoot: opts.workspaceRoot,
            capabilities,
            notify: (method, params) => {
              session.emit(method, params);
              // 轨迹持久化（P3.4）：仅 trajectory.record 事件落盘
              if (method === EVENTS.Trajectory) {
                trajectoryStore.append(session.id, params as EventTrajectory);
              }
            },
            waitForUser: (kind, snapshot) => {
              if (kind === 'approval') {
                return session.registerApproval(snapshot as EventApprovalRequest);
              }
              return session.registerPatch(snapshot as EventFilePatchPending);
            },
            isCanceled: () => session.isCanceled(),
            readFile: async (target, maxBytes) => {
              const r = resolvePath(target);
              if ('error' in r) return undefined;
              try {
                const content = fs.readFileSync(r.resolved, 'utf8');
                const cap = maxBytes ?? MAX_READ_BYTES;
                return content.length > cap ? content.slice(0, cap) + '\n…[truncated]' : content;
              } catch {
                return undefined;
              }
            },
          };
          // P3.6：auto 切换 —— 有 apiKey（或显式 real）走真实模型，否则回退内置模拟
          const agentMode = resolveAgentMode();
          if (agentMode === 'real') {
            const model = createModel();
            const agentConfig: RealAgentConfig = { model };
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
        case METHODS.ApprovalRespond: {
          const p = req.params as { sessionId?: string; approvalId: string; approved: boolean };
          const session = sessions.get(p?.sessionId ?? conn.currentSessionId);
          if (!session) {
            sendError(conn.ws, req.id, ERROR_CODES.NotFound, 'session 不存在');
            return;
          }
          const r = session.respondApproval(p?.approvalId ?? '', !!p?.approved);
          if (r === 'not_found') {
            sendError(conn.ws, req.id, ERROR_CODES.NotFound, `审批不存在或已处理: ${p?.approvalId}`);
            return;
          }
          if (r === 'expired') {
            sendError(conn.ws, req.id, ERROR_CODES.Expired, `审批已过期: ${p?.approvalId}`);
            return;
          }
          sendResult(conn.ws, req.id, { ok: true });
          return;
        }
        case METHODS.FilePatchRespond: {
          const p = req.params as { sessionId?: string; patchId: string; accept: boolean };
          const session = sessions.get(p?.sessionId ?? conn.currentSessionId);
          if (!session) {
            sendError(conn.ws, req.id, ERROR_CODES.NotFound, 'session 不存在');
            return;
          }
          const r = session.respondPatch(p?.patchId ?? '', !!p?.accept);
          if (r === 'not_found') {
            sendError(conn.ws, req.id, ERROR_CODES.NotFound, `补丁不存在或已处理: ${p?.patchId}`);
            return;
          }
          if (r === 'expired') {
            sendError(conn.ws, req.id, ERROR_CODES.Expired, `补丁已过期: ${p?.patchId}`);
            return;
          }
          sendResult(conn.ws, req.id, { ok: true });
          return;
        }
        case METHODS.FileRead: {
          const p = req.params as { path: string; maxBytes?: number };
          const r = resolvePath(p?.path ?? '');
          if ('error' in r) {
            sendError(conn.ws, req.id, ERROR_CODES.PathOutsideWorkspace, r.error);
            return;
          }
          try {
            const content = fs.readFileSync(r.resolved, 'utf8');
            const cap = p.maxBytes ?? MAX_READ_BYTES;
            const truncated = content.length > cap;
            sendResult(conn.ws, req.id, {
              content: truncated ? content.slice(0, cap) : content,
              truncated,
              size: Buffer.byteLength(content, 'utf8'),
            });
          } catch (e) {
            sendError(conn.ws, req.id, ERROR_CODES.InternalError, `读取失败: ${e instanceof Error ? e.message : String(e)}`);
          }
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
