import { describe, expect, it } from 'vitest';
import { MAX_SESSIONS, MementoLike, SessionHistoryStore } from './sessionHistory';

/** 内存假体：模拟 vscode.Memento（workspaceState）的同步读写语义。 */
class FakeMemento implements MementoLike {
  private readonly store = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.store.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Promise<void> {
    this.store.set(key, value);
    return Promise.resolve();
  }
}

/** 递增时钟，保证 createdAt / ts 严格递增，便于断言最新/排序。 */
function makeClock(): () => number {
  let t = 1_000_000;
  return () => t++;
}

describe('SessionHistoryStore：完整会话生命周期（真实流转）', () => {
  it('用户提问 + token 级流式回答逐字完整落库、顺序正确、title 自动生成', () => {
    const store = new SessionHistoryStore(new FakeMemento(), makeClock());

    store.appendUser('s1', '请解释什么是递归');
    const tokens = ['递归', '是', '函数', '在内部', '调用', '自身', '的过程'];
    for (const t of tokens) store.appendAssistantDelta('s1', t);
    store.finishAssistant('s1');
    store.endSession('s1');

    const rec = store.get('s1')!;
    expect(rec.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(rec.messages[0].text).toBe('请解释什么是递归');
    // 关键：流式 delta 逐字拼接、不丢字、不换序
    expect(rec.messages[1].text).toBe(tokens.join(''));
    expect(rec.title).toBe('请解释什么是递归');
    expect(rec.endedAt).toBeDefined();
  });

  it('多轮对话的消息顺序保持 user/assistant 交错', () => {
    const store = new SessionHistoryStore(new FakeMemento(), makeClock());
    store.appendUser('s1', '第一问');
    store.appendAssistantDelta('s1', '第一答');
    store.finishAssistant('s1');
    store.appendUser('s1', '第二问');
    store.appendAssistantDelta('s1', '第二答');
    store.finishAssistant('s1');

    expect(store.get('s1')!.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
  });
});

describe('SessionHistoryStore：持久化往返（面板重开不丢）', () => {
  it('新实例从同一 memento 恢复，数据一致', () => {
    const memento = new FakeMemento();
    const first = new SessionHistoryStore(memento, makeClock());
    first.appendUser('s1', '问题A');
    first.appendAssistantDelta('s1', '回答A');
    first.finishAssistant('s1');
    first.endSession('s1');

    const second = new SessionHistoryStore(memento, makeClock());
    expect(second.list()).toHaveLength(1);
    expect(second.get('s1')!.messages[0].text).toBe('问题A');
    expect(second.get('s1')!.messages[1].text).toBe('回答A');
    expect(second.get('s1')!.endedAt).toBeDefined();
  });

  it('加载损坏数据（非数组）时安全回退为空', () => {
    const memento = new FakeMemento();
    void memento.update('dsh.sessionHistory.v1', 'garbage');
    const store = new SessionHistoryStore(memento, makeClock());
    expect(store.list()).toEqual([]);
  });
});

describe('SessionHistoryStore：多会话隔离', () => {
  it('不同 sessionId 的流式内容互不串扰', () => {
    const store = new SessionHistoryStore(new FakeMemento(), makeClock());
    store.appendAssistantDelta('s1', 'A1-');
    store.appendAssistantDelta('s2', 'B1-');
    store.appendAssistantDelta('s1', 'A2');
    store.appendAssistantDelta('s2', 'B2');
    store.finishAssistant('s1');
    store.finishAssistant('s2');

    expect(store.get('s1')!.messages[0].text).toBe('A1-A2');
    expect(store.get('s2')!.messages[0].text).toBe('B1-B2');
  });

  it('list 按创建时间倒序，最新会话在前', () => {
    const store = new SessionHistoryStore(new FakeMemento(), makeClock());
    store.appendUser('older', '旧会话');
    store.appendUser('newer', '新会话');
    const list = store.list();
    expect(list[0].sessionId).toBe('newer');
    expect(list[1].sessionId).toBe('older');
  });
});

describe('SessionHistoryStore：存储上限与兜底', () => {
  it('超长消息截断并保留标记', () => {
    const store = new SessionHistoryStore(new FakeMemento(), makeClock());
    const long = 'x'.repeat(50_000);
    store.appendUser('s1', long);
    const text = store.get('s1')!.messages[0].text;
    expect(text.length).toBeLessThan(long.length);
    expect(text).toContain('截断');
  });

  it('未显式 finish 的流式回答在 endSession 时兜底落库', () => {
    const store = new SessionHistoryStore(new FakeMemento(), makeClock());
    store.appendUser('s1', 'hi');
    store.appendAssistantDelta('s1', '话没说完就结束了');
    store.endSession('s1'); // 不调 finishAssistant
    expect(store.get('s1')!.messages[1].text).toBe('话没说完就结束了');
  });

  it('超过 MAX_SESSIONS 裁剪最旧会话，最新会话保留', () => {
    const store = new SessionHistoryStore(new FakeMemento(), makeClock());
    const total = MAX_SESSIONS + 5;
    for (let i = 0; i < total; i++) {
      store.appendUser('s' + i, 'msg ' + i);
      store.persist();
    }
    const list = store.list();
    expect(list.length).toBeLessThanOrEqual(MAX_SESSIONS);
    expect(store.get('s0')).toBeUndefined(); // 最旧被裁剪
    expect(store.get('s' + (total - 1))).toBeDefined(); // 最新保留
  });
});

describe('SessionHistoryStore：边界', () => {
  it('无历史时 list 为空、get 返回 undefined', () => {
    const store = new SessionHistoryStore(new FakeMemento(), makeClock());
    expect(store.list()).toEqual([]);
    expect(store.get('missing')).toBeUndefined();
  });

  it('空 delta 不产生任何会话记录', () => {
    const store = new SessionHistoryStore(new FakeMemento(), makeClock());
    store.appendAssistantDelta('s1', '');
    store.finishAssistant('s1');
    // 空输入不应创建会话记录（无实质内容）
    expect(store.get('s1')).toBeUndefined();
    expect(store.list()).toEqual([]);
  });
});