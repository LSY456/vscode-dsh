/**
 * 瞬时失败自动重试（withRetry）。
 *
 * 为什么需要它：真实会话里三次「模型调用失败」有两次在 ~110ms 内就返回了，
 * 而 19 秒后的同一请求却成功 —— 典型的瞬时失败（网络抖动 / 429）。
 * 当时没有重试，一次抖动就等于整场会话"自动中断"，用户什么结论都拿不到。
 *
 * 反过来的约束同样要钉死：**已经推送过增量就不能重试**，否则同一段正文会被推第二遍。
 */
import { describe, expect, it } from 'vitest';
import { ChatCompletionResult, ChatMessage, ChatModel, withRetry } from './model';

/** 测试用极小退避，避免每个用例白等 600ms。 */
const FAST = { baseDelayMs: 1 };

const msgs: ChatMessage[] = [{ role: 'user', content: 'x' }];

/** 前若干个错误依次抛出、之后成功；返回调用次数。 */
function flakyModel(errors: Array<Error | undefined>): { model: ChatModel; calls: () => number } {
  let n = 0;
  const model: ChatModel = {
    async chat(_messages, opts = {}): Promise<ChatCompletionResult> {
      const err = errors[n++];
      if (err) throw err;
      opts.onChunk?.({ type: 'content', text: 'ok' });
      return { reasoning: '', content: 'ok' };
    },
  };
  return { model, calls: () => n };
}

/** 带状态码的 HTTP 错误（与 describeHttpError 产出的形态一致）。 */
function httpError(status: number): Error {
  const e = new Error(`HTTP ${status}`);
  (e as Error & { httpStatus?: number }).httpStatus = status;
  return e;
}

/** 带 name 的错误（AbortError / TimeoutError 由运行时按 name 区分）。 */
function namedError(name: string): Error {
  const e = new Error(name === 'AbortError' ? '模型请求已取消。' : '模型响应空闲超时');
  e.name = name;
  return e;
}

describe('withRetry：瞬时失败自动重试', () => {
  it('网络层错误重试后成功：调用两次，调用方完全无感', async () => {
    const { model, calls } = flakyModel([new TypeError('fetch failed')]);
    const res = await withRetry(model, FAST).chat(msgs);
    expect(res.content).toBe('ok');
    expect(calls()).toBe(2);
  });

  it('429 与 5xx 可重试', async () => {
    for (const status of [429, 500, 503]) {
      const { model, calls } = flakyModel([httpError(status)]);
      await expect(withRetry(model, FAST).chat(msgs)).resolves.toBeTruthy();
      expect(calls(), `status=${status} 应重试`).toBe(2);
    }
  });

  it('其余 4xx 是确定性错误：不重试（重试只会让用户多等一秒再读同一句话）', async () => {
    for (const status of [400, 401, 402, 403, 404, 413, 422]) {
      const { model, calls } = flakyModel([httpError(status)]);
      await expect(withRetry(model, FAST).chat(msgs)).rejects.toThrow(`HTTP ${status}`);
      expect(calls(), `status=${status} 不应重试`).toBe(1);
    }
  });

  it('重试次数用尽 -> 抛出最后一次的错误（不无限重试）', async () => {
    const { model, calls } = flakyModel([
      new TypeError('第一次失败'),
      new TypeError('第二次失败'),
      new TypeError('第三次失败'),
    ]);
    await expect(withRetry(model, { ...FAST, maxRetries: 2 }).chat(msgs)).rejects.toThrow('第三次失败');
    expect(calls()).toBe(3); // 首次 + 2 次重试
  });

  it('已推送过增量就不再重试（否则前端会看到重复正文）', async () => {
    let n = 0;
    const model: ChatModel = {
      async chat(_m, opts = {}) {
        n++;
        opts.onChunk?.({ type: 'content', text: '半句话' });
        throw new TypeError('连接在半途断掉');
      },
    };
    await expect(withRetry(model, FAST).chat(msgs)).rejects.toThrow('半途');
    expect(n).toBe(1);
  });

  it('取消 / 空闲超时不重试', async () => {
    for (const name of ['AbortError', 'TimeoutError']) {
      const { model, calls } = flakyModel([namedError(name)]);
      await expect(withRetry(model, FAST).chat(msgs)).rejects.toThrow();
      expect(calls(), name).toBe(1);
    }
  });

  it('已取消的 signal 不再重试（用户已经不等了）', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const { model, calls } = flakyModel([new TypeError('fetch failed')]);
    await expect(withRetry(model, FAST).chat(msgs, { signal: ctrl.signal })).rejects.toThrow('fetch failed');
    expect(calls()).toBe(1);
  });

  it('maxRetries=0 关闭重试（标题生成这类短请求用）', async () => {
    const { model, calls } = flakyModel([new TypeError('fetch failed')]);
    await expect(withRetry(model, FAST).chat(msgs, { maxRetries: 0 })).rejects.toThrow('fetch failed');
    expect(calls()).toBe(1);
  });

  it('onChunk 被原样透传（包装层不吞增量）', async () => {
    const chunks: string[] = [];
    const { model } = flakyModel([]);
    await withRetry(model, FAST).chat(msgs, { onChunk: (c) => chunks.push(c.text) });
    expect(chunks).toEqual(['ok']);
  });
});
