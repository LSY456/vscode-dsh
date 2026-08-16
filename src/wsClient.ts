/**
 * dsh daemon 的 WebSocket/JSON-RPC 客户端。
 *
 * 职责：
 *  - 建立/断开连接（连接管理、重连策略由 DaemonManager 负责）
 *  - 请求-响应（Promise + id 映射）
 *  - 通知（事件）分发：connection -> event 订阅者
 *  - 发送侧按行发送 JSON（与 daemon 逐帧解析一致）
 */
import WebSocket from 'ws';
import {
  isJsonRpcNotification,
  isJsonRpcResponse,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  METHODS,
} from '../shared/protocol';

export interface DshClientOptions {
  url: string;
  token: string;
  timeoutMs?: number;
}

type Listener<T> = (payload: T) => void;

export class DshClient {
  url: string;
  private token: string;
  private readonly timeoutMs: number;

  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  private eventListeners = new Set<Listener<JsonRpcNotification>>();
  private openListeners = new Set<Listener<void>>();
  private closeListeners = new Set<Listener<{ code?: number; reason?: string }>>();
  private errorListeners = new Set<Listener<Error>>();

  private closedByUs = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private heartbeatInFlight = false;

  constructor(opts: DshClientOptions) {
    this.url = opts.url;
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  /** 更新握手令牌（重连到新 daemon 时使用）。 */
  setToken(token: string): void {
    this.token = token;
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  onEvent(l: Listener<JsonRpcNotification>): void {
    this.eventListeners.add(l);
  }
  onOpen(l: Listener<void>): void {
    this.openListeners.add(l);
  }
  onClose(l: Listener<{ code?: number; reason?: string }>): void {
    this.closeListeners.add(l);
  }
  onError(l: Listener<Error>): void {
    this.errorListeners.add(l);
  }

  /** 打开连接并等待 open 事件。 */
  connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.ws && this.isOpen) {
        resolve();
        return;
      }
      this.closedByUs = false;
      let settled = false;
      const ws = new WebSocket(this.url, {
        headers: { Authorization: `Bearer ${this.token}` },
        handshakeTimeout: 10_000,
      });
      this.ws = ws;

      ws.on('open', () => {
        if (!settled) {
          settled = true;
          resolve();
        }
        this.openListeners.forEach((l) => l());
      });

      ws.on('message', (data: WebSocket.RawData) => {
        let msg: unknown;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        this.dispatch(msg);
      });

      ws.on('error', (err: Error) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
        this.errorListeners.forEach((l) => l(err));
      });

      ws.on('close', (code: number, reason: Buffer) => {
        const info = { code, reason: reason?.toString() ?? '' };
        this.rejectAllPending(new Error(`连接关闭 (${code})`));
        if (!this.closedByUs) {
          this.closeListeners.forEach((l) => l(info));
        }
      });
    });
  }

  /** 请求-响应。 */
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.ws || !this.isOpen) {
        reject(new Error('daemon 未连接'));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`请求超时: ${method}`));
      }, timeoutMs ?? this.timeoutMs);
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
      });
      const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
      this.ws.send(JSON.stringify(req));
    });
  }

  /** 发送通知（无响应）。 */
  notify(method: string, params?: unknown): void {
    if (!this.ws || !this.isOpen) return;
    this.ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
  }

  close(): void {
    this.closedByUs = true;
    this.stopHeartbeat();
    this.rejectAllPending(new Error('客户端主动关闭'));
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }

  /**
   * 心跳（P1.2）：周期性 ping，连续失败超过阈值判定链路死亡，
   * 由调用方决定是否关闭并重连（通过 onDead 回调）。
   */
  startHeartbeat(opts: { intervalMs?: number; timeoutMs?: number; maxMisses?: number; onDead: () => void }): void {
    this.stopHeartbeat();
    const intervalMs = opts.intervalMs ?? 15_000;
    const timeoutMs = opts.timeoutMs ?? 3000;
    const maxMisses = opts.maxMisses ?? 3;
    let misses = 0;
    this.heartbeatTimer = setInterval(() => {
      if (!this.isOpen || this.heartbeatInFlight) return;
      this.heartbeatInFlight = true;
      this.request(METHODS.Ping, undefined, timeoutMs)
        .then(() => {
          misses = 0;
        })
        .catch(() => {
          misses++;
          if (misses >= maxMisses) {
            this.stopHeartbeat();
            opts.onDead();
          }
        })
        .finally(() => {
          this.heartbeatInFlight = false;
        });
    }, intervalMs);
    this.heartbeatTimer.unref?.();
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private dispatch(msg: unknown): void {
    if (isJsonRpcResponse(msg)) {
      this.settleResponse(msg);
      return;
    }
    if (isJsonRpcNotification(msg)) {
      this.eventListeners.forEach((l) => l(msg));
      return;
    }
    // 忽略无法识别的帧
  }

  private settleResponse(res: JsonRpcResponse): void {
    const entry = this.pending.get(res.id as number);
    if (!entry) return;
    this.pending.delete(res.id as number);
    clearTimeout(entry.timer);
    if (res.error) {
      const err = new Error(res.error.message) as Error & { code?: number };
      err.code = res.error.code;
      entry.reject(err);
    } else {
      entry.resolve(res.result);
    }
  }

  private rejectAllPending(err: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }
}
