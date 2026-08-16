/**
 * dsh 参考 daemon：WebSocket/JSON-RPC 服务端。
 *
 * 安全设计（对应方案"工程化核心关注点"）：
 *  - 仅绑定 127.0.0.1（默认随机端口）
 *  - 打开握手必须携带 `Authorization: Bearer <token>`（verifyClient 校验）
 *  - 拒绝来自浏览器 Origin 的连接（防跨站 WebSocket 劫持 CSWSH）
 *  - token 通过环境变量/启动参数传入，不写盘（可选 --port-file 只写端口）
 */
import * as http from 'http';
import { WebSocket, WebSocketServer, RawData } from 'ws';
import {
  EVENTS,
  isJsonRpcNotification,
  isJsonRpcRequest,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  METHODS,
  InitializeParams,
  InitializeResult,
  SessionSendParams,
} from '../../shared/protocol';
import { AgentContext, runFakeAgent } from './agent';

export interface DaemonServerOptions {
  token: string;
  workspaceRoot: string;
  preset?: string;
  apiKey?: string;
  port?: number;
  /** 端口就绪后回调（随机端口时用于上报） */
  onPort?: (port: number) => void;
}

export interface DaemonServerHandle {
  port: number;
  close(): Promise<void>;
}

interface PendingUser {
  resolve: (approved: boolean) => void;
}

interface Connection {
  ws: WebSocket;
  sessionId: string;
  running: boolean;
  canceled: boolean;
  pendingApproval: Map<string, PendingUser>;
  pendingPatch: Map<string, PendingUser>;
  notify(method: string, params: unknown): void;
}

export async function startDaemonServer(opts: DaemonServerOptions): Promise<DaemonServerHandle> {
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

  const connections = new Set<Connection>();

  wss.on('connection', (ws: WebSocket) => {
    const conn: Connection = {
      ws,
      sessionId: '',
      running: false,
      canceled: false,
      pendingApproval: new Map(),
      pendingPatch: new Map(),
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
        sendError(ws, null, -32700, 'Parse error');
        return;
      }
      handleMessage(conn, msg);
    });

    ws.on('close', () => {
      connections.delete(conn);
    });
  });

  function handleMessage(conn: Connection, msg: unknown): void {
    if (isJsonRpcRequest(msg)) {
      void handleRequest(conn, msg);
    } else if (isJsonRpcNotification(msg)) {
      handleNotification(conn, msg);
    } else {
      const maybeId = (msg as { id?: number | string } | null)?.id;
      sendError(conn.ws, maybeId ?? null, -32600, 'Invalid Request');
    }
  }

  async function handleRequest(conn: Connection, req: JsonRpcRequest): Promise<void> {
    try {
      switch (req.method) {
        case METHODS.Initialize: {
          const p = req.params as InitializeParams;
          if (!p || !p.workspaceRoot) {
            sendError(conn.ws, req.id, -32602, 'initialize 需要 workspaceRoot');
            return;
          }
          const result: InitializeResult = {
            daemonVersion: '0.1.0-reference',
            protocolVersion: '1.0',
            capabilities: {
              streaming: true,
              approvals: true,
              filePatches: true,
              sessions: true,
              trajectory: true,
            },
          };
          conn.sessionId = `sess_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
          sendResult(conn.ws, req.id, result);
          return;
        }
        case METHODS.SessionCreate: {
          if (!conn.sessionId) conn.sessionId = `sess_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
          sendResult(conn.ws, req.id, { sessionId: conn.sessionId });
          return;
        }
        case METHODS.SessionSend: {
          const p = req.params as SessionSendParams;
          if (!p || typeof p.prompt !== 'string') {
            sendError(conn.ws, req.id, -32602, 'session.send 需要 prompt');
            return;
          }
          if (conn.running) {
            sendError(conn.ws, req.id, -32009, 'session 正在运行中，请先取消或等待完成');
            return;
          }
          conn.running = true;
          conn.canceled = false;
          sendResult(conn.ws, req.id, { sessionId: conn.sessionId, accepted: true });
          const ctx: AgentContext = {
            sessionId: conn.sessionId,
            notify: (method, params) => conn.notify(method, params),
            waitForUser: (kind, id) => waitForUser(conn, kind, id),
            isCanceled: () => conn.canceled,
          };
          // 异步执行，不阻塞请求响应
          void runFakeAgent(ctx, p).finally(() => {
            conn.running = false;
          });
          return;
        }
        case METHODS.SessionCancel: {
          conn.canceled = true;
          // 挂起的审批/补丁按拒绝处理
          for (const pending of conn.pendingApproval.values()) pending.resolve(false);
          conn.pendingApproval.clear();
          for (const pending of conn.pendingPatch.values()) pending.resolve(false);
          conn.pendingPatch.clear();
          sendResult(conn.ws, req.id, { canceled: true });
          return;
        }
        case METHODS.ApprovalRespond: {
          const p = req.params as { approvalId: string; approved: boolean };
          const pending = conn.pendingApproval.get(p?.approvalId ?? '');
          if (pending) {
            conn.pendingApproval.delete(p.approvalId);
            pending.resolve(!!p.approved);
          }
          sendResult(conn.ws, req.id, { ok: true });
          return;
        }
        case METHODS.FilePatchRespond: {
          const p = req.params as { patchId: string; accept: boolean };
          const pending = conn.pendingPatch.get(p?.patchId ?? '');
          if (pending) {
            conn.pendingPatch.delete(p.patchId);
            pending.resolve(!!p.accept);
          }
          sendResult(conn.ws, req.id, { ok: true });
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
          sendError(conn.ws, req.id, -32601, `Method not found: ${req.method}`);
      }
    } catch (err) {
      sendError(conn.ws, req.id, -32603, err instanceof Error ? err.message : String(err));
    }
  }

  function handleNotification(conn: Connection, note: JsonRpcNotification): void {
    // 参考实现暂不需要客户端通知；预留扩展点
    void note;
  }

  function waitForUser(conn: Connection, kind: 'approval' | 'patch', id: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const entry: PendingUser = { resolve };
      if (kind === 'approval') conn.pendingApproval.set(id, entry);
      else conn.pendingPatch.set(id, entry);
      // 60s 超时按拒绝处理
      setTimeout(() => {
        if (kind === 'approval' ? conn.pendingApproval.delete(id) : conn.pendingPatch.delete(id)) {
          entry.resolve(false);
        }
      }, 60_000);
    });
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
      }),
  };
}
