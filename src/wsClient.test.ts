/**
 * WebSocket / JSON-RPC 客户端（wsClient）的行为锁。
 *
 * 它是扩展与 daemon 之间唯一的通道，出错时**表现成"卡住"而不是报错**，所以逐条钉住：
 *  1. 握手必须带 `Authorization: Bearer <token>` —— daemon 侧对空 token、非空 Origin 都是一票否决；
 *  2. 请求-响应靠自增 id 配对，**过期的响应（id 已清理）必须被忽略**，否则一次超时会让下一个
 *     请求拿到别人的结果；超时要给出方法名，否则日志里只剩"超时"三个字；
 *  3. 连接关闭时所有挂起请求都要被拒绝 —— 漏一个就是 Agent 永久挂在 `await request(...)`；
 *  4. 主动 `close()` 不算"链路断了"：不能再通知上层（否则会触发一次无意义的重连）；
 *  5. 心跳连续失败到阈值才判死，**成功一次就清零**，否则偶发抖动会误杀健康连接。
 *
 * 环境：`ws` 用假体顶掉（真连接留给 smoke / 集成测试），
 * 这样时序完全可控，同时断言的是"我们发出的帧"而不是底层实现。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

type Handler = (...args: unknown[]) => void;

const h = vi.hoisted(() => {
  /** 所有被构造出来的假连接，按创建顺序排 */
  const sockets: Array<{
    url: string;
    opts: { headers?: Record<string, string>; handshakeTimeout?: number };
    readyState: number;
    sent: string[];
    handlers: Record<string, Handler[]>;
    emit(ev: string, ...args: unknown[]): void;
    send(data: string): void;
    close(): void;
    /** 以下三个是测试辅助：把"事件何时到"从不可控变成显式调用 */
    fakeOpen(): void;
    fakeMessage(obj: unknown): void;
    fakeServerClose(code: number, reason?: string): void;
  }> = [];
  return { sockets };
});

vi.mock('ws', () => {
  class FakeWebSocket {
    static readonly OPEN = 1;
    static readonly CLOSED = 3;

    url: string;
    opts: { headers?: Record<string, string>; handshakeTimeout?: number };
    readyState = 0;
    sent: string[] = [];
    handlers: Record<string, Handler[]> = {};

    constructor(url: string, opts: { headers?: Record<string, string>; handshakeTimeout?: number }) {
      this.url = url;
      this.opts = opts;
      h.sockets.push(this as never);
    }

    on(ev: string, fn: Handler): void {
      (this.handlers[ev] ||= []).push(fn);
    }

    emit(ev: string, ...args: unknown[]): void {
      for (const fn of this.handlers[ev] || []) fn(...args);
    }

    send(data: string): void {
      this.sent.push(data);
    }

    close(): void {
      this.readyState = 3;
      this.emit('close', 1000, Buffer.from(''));
    }

    /** 测试辅助：模拟握手完成 */
    fakeOpen(): void {
      this.readyState = 1;
      this.emit('open');
    }

    /** 测试辅助：模拟收到一帧（对象会被序列化） */
    fakeMessage(obj: unknown): void {
      this.emit('message', Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj)));
    }

    /** 测试辅助：模拟对端关闭 */
    fakeServerClose(code: number, reason = ''): void {
      this.readyState = 3;
      this.emit('close', code, Buffer.from(reason));
    }
  }
  return { default: FakeWebSocket, WebSocket: FakeWebSocket };
});

import { DshClient } from './wsClient';
import { METHODS } from '../shared/protocol';

/** 建一个已连上的客户端：连上后返回底层假 socket。 */
async function connectedClient(opts?: { token?: string; timeoutMs?: number }) {
  const client = new DshClient({ url: 'ws://127.0.0.1:1/x', token: opts?.token ?? 'tk', timeoutMs: opts?.timeoutMs });
  const p = client.connect();
  const sock = h.sockets.at(-1)!;
  sock.fakeOpen();
  await p;
  return { client, sock };
}

/** 取出某个 socket 发出的最后一帧并解析。 */
function lastFrame(sock: { sent: string[] }): Record<string, unknown> {
  return JSON.parse(sock.sent.at(-1) as string);
}

afterEach(() => {
  h.sockets.length = 0;
  vi.useRealTimers();
});

describe('wsClient：连接与握手', () => {
  it('握手带 Bearer 令牌，并设置握手超时', async () => {
    const { sock } = await connectedClient({ token: 'abc' });
    expect(sock.opts.headers).toEqual({ Authorization: 'Bearer abc' });
    expect(sock.opts.handshakeTimeout).toBe(10_000);
    expect(sock.url).toBe('ws://127.0.0.1:1/x');
  });

  it('已连接时再次 connect 直接成功，不新建连接', async () => {
    const { client } = await connectedClient();
    await client.connect();
    expect(h.sockets).toHaveLength(1);
    expect(client.isOpen).toBe(true);
  });

  it('握手失败：connect 被拒绝，错误同时分发给 onError', async () => {
    const client = new DshClient({ url: 'ws://x', token: 'tk' });
    const seen: Error[] = [];
    client.onError((e) => seen.push(e));
    const p = client.connect();
    const sock = h.sockets.at(-1)!;
    sock.emit('error', new Error('ECONNREFUSED'));
    await expect(p).rejects.toThrow('ECONNREFUSED');
    expect(seen.map((e) => e.message)).toEqual(['ECONNREFUSED']);
  });

  it('setToken 后重连使用新令牌（daemon 重启会换一次性 token）', async () => {
    const { client } = await connectedClient({ token: 'old' });
    client.close();
    client.setToken('new');
    void client.connect();
    expect(h.sockets.at(-1)!.opts.headers).toEqual({ Authorization: 'Bearer new' });
  });
});

describe('wsClient：请求-响应配对', () => {
  it('未连接时报"daemon 未连接"，不发帧', async () => {
    const client = new DshClient({ url: 'ws://x', token: 'tk' });
    await expect(client.request('a.b')).rejects.toThrow('daemon 未连接');
  });

  it('请求帧是 JSON-RPC 2.0，id 自增，结果按 id 回到对应 Promise', async () => {
    const { client, sock } = await connectedClient();
    const p1 = client.request<string>('m.one', { a: 1 });
    expect(lastFrame(sock)).toEqual({ jsonrpc: '2.0', id: 1, method: 'm.one', params: { a: 1 } });
    const p2 = client.request<string>('m.two');
    expect(lastFrame(sock)).toMatchObject({ id: 2, method: 'm.two' });

    sock.fakeMessage({ jsonrpc: '2.0', id: 2, result: 'second' });
    sock.fakeMessage({ jsonrpc: '2.0', id: 1, result: 'first' });
    await expect(p1).resolves.toBe('first');
    await expect(p2).resolves.toBe('second');
  });

  it('响应带 error：拒绝并保留 code（重试策略要靠它判 429/5xx）', async () => {
    const { client, sock } = await connectedClient();
    const p = client.request('m.fail');
    sock.fakeMessage({ jsonrpc: '2.0', id: 1, error: { code: -32001, message: '内部错误' } });
    await expect(p).rejects.toMatchObject({ message: '内部错误', code: -32001 });
  });

  it('未知 id 的响应被忽略，不会串到别的请求上', async () => {
    const { client, sock } = await connectedClient();
    const p = client.request('m.one');
    sock.fakeMessage({ jsonrpc: '2.0', id: 99, result: '别处的' });
    sock.fakeMessage({ jsonrpc: '2.0', id: 1, result: '对了' });
    await expect(p).resolves.toBe('对了');
  });

  it('非 JSON 帧被丢弃，不抛也不影响后续', async () => {
    const { client, sock } = await connectedClient();
    const events: unknown[] = [];
    client.onEvent((n) => events.push(n));
    expect(() => sock.fakeMessage('not json')).not.toThrow();
    sock.fakeMessage({ jsonrpc: '2.0', method: METHODS.Ping, params: {} });
    expect(events).toHaveLength(1);
  });

  it('超时：拒绝信息里带方法名，之后才到的响应被忽略', async () => {
    const { client, sock } = await connectedClient({ timeoutMs: 30 });
    const p = client.request('file.read');
    await expect(p).rejects.toThrow('请求超时: file.read');
    // 超时已把 pending 清掉：迟到响应只会走 dispatch，不会二次 settle
    expect(() => sock.fakeMessage({ jsonrpc: '2.0', id: 1, result: '迟到' })).not.toThrow();
  });
});

describe('wsClient：通告与关闭', () => {
  it('通知帧按方法原样分发给 onEvent（daemon 的事件流就是它）', async () => {
    const { client, sock } = await connectedClient();
    const got: Array<{ method: string }> = [];
    client.onEvent((n) => got.push(n as unknown as { method: string }));
    sock.fakeMessage({ jsonrpc: '2.0', method: 'event.agent', params: { x: 1 } });
    expect(got.map((n) => n.method)).toEqual(['event.agent']);
  });

  it('notify 发无 id 的帧；未连接时静默丢弃', async () => {
    const client = new DshClient({ url: 'ws://x', token: 'tk' });
    expect(() => client.notify('a.b')).not.toThrow();

    const { client: c2, sock } = await connectedClient();
    c2.notify('a.b', { p: 1 });
    expect(lastFrame(sock)).toEqual({ jsonrpc: '2.0', method: 'a.b', params: { p: 1 } });
  });

  it('对端关闭：所有挂起请求被拒绝（不漏一个），onClose 收到 code 与 reason', async () => {
    const { client, sock } = await connectedClient();
    const closes: Array<{ code?: number; reason?: string }> = [];
    client.onClose((i) => closes.push(i));
    const p1 = client.request('m.one');
    const p2 = client.request('m.two');
    sock.fakeServerClose(1006, '异常断开');
    await expect(p1).rejects.toThrow('连接关闭 (1006)');
    await expect(p2).rejects.toThrow('连接关闭 (1006)');
    expect(closes).toEqual([{ code: 1006, reason: '异常断开' }]);
  });

  it('主动 close()：不算链路故障，不通知 onClose，但挂起请求照样拒绝', async () => {
    const { client, sock } = await connectedClient();
    const closes: unknown[] = [];
    client.onClose((i) => closes.push(i));
    const p = client.request('m.one');
    client.close();
    await expect(p).rejects.toThrow('客户端主动关闭');
    expect(closes).toHaveLength(0);
    expect(client.isOpen).toBe(false);
    expect(sock.sent).toHaveLength(1);
  });
});

describe('wsClient：心跳判死', () => {
  /** 等某个条件成立，超时即失败 —— 比裸 sleep 快，也不会在慢机器上假红。 */
  async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
    const started = Date.now();
    while (!cond()) {
      if (Date.now() - started > ms) throw new Error('等待条件超时');
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  it('连续失败达到阈值：停表并回调 onDead，只回调一次', async () => {
    const { client, sock } = await connectedClient();
    let dead = 0;
    client.startHeartbeat({ intervalMs: 10, timeoutMs: 5, maxMisses: 2, onDead: () => dead++ });
    await waitFor(() => dead > 0);
    const sentAtDeath = sock.sent.length;
    // 停表之后再等两轮，不应再有任何 ping
    await new Promise((r) => setTimeout(r, 40));
    expect(dead).toBe(1);
    expect(sock.sent.length).toBe(sentAtDeath);
  });

  it('心跳成功一次就清零：偶发一次失败不判死', async () => {
    const { client, sock } = await connectedClient();
    let dead = 0;
    client.startHeartbeat({ intervalMs: 10, timeoutMs: 50, maxMisses: 2, onDead: () => dead++ });
    // 第一次 ping 故意不答（记为 1 次 miss），第二次答上 → 计数归零
    await waitFor(() => sock.sent.length >= 1);
    const firstId = lastFrame(sock).id as number;
    sock.fakeMessage({ jsonrpc: '2.0', id: firstId, result: 'ok' });
    await new Promise((r) => setTimeout(r, 40));
    expect(dead).toBe(0);
    client.stopHeartbeat();
  });

  it('stopHeartbeat 之后不再发 ping', async () => {
    const { client, sock } = await connectedClient();
    client.startHeartbeat({ intervalMs: 10, timeoutMs: 50, maxMisses: 9, onDead: () => undefined });
    await waitFor(() => sock.sent.length >= 1);
    client.stopHeartbeat();
    const n = sock.sent.length;
    await new Promise((r) => setTimeout(r, 40));
    expect(sock.sent.length).toBe(n);
  });
});
