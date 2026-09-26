import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DEFAULT_MAX_SESSIONS, FileMemento, MementoLike, SessionHistoryStore } from './sessionHistory';

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

  it('超过缺省上限裁剪最旧会话，最新会话保留', () => {
    const store = new SessionHistoryStore(new FakeMemento(), makeClock());
    const total = DEFAULT_MAX_SESSIONS + 5;
    for (let i = 0; i < total; i++) {
      store.appendUser('s' + i, 'msg ' + i);
      store.persist();
    }
    const list = store.list();
    expect(list.length).toBeLessThanOrEqual(DEFAULT_MAX_SESSIONS);
    expect(store.get('s0')).toBeUndefined(); // 最旧被裁剪
    expect(store.get('s' + (total - 1))).toBeDefined(); // 最新保留
  });
});

describe('SessionHistoryStore：保留条数可配置（dsh.history.maxSessions）', () => {
  /** 逐条写入 n 个会话（每次写入即触发一次裁剪） */
  function fill(store: SessionHistoryStore, n: number): void {
    for (let i = 0; i < n; i++) {
      store.appendUser('s' + i, 'msg ' + i);
      store.persist();
    }
  }

  it('上限 10 + 写入 60 条 → 恰留最新 10 条（旧的全裁掉）', () => {
    const store = new SessionHistoryStore(new FakeMemento(), makeClock(), { maxSessions: () => 10 });
    fill(store, 60);

    expect(store.list()).toHaveLength(10);
    expect(store.get('s59')).toBeDefined(); // 最新保留
    expect(store.get('s50')).toBeDefined(); // 恰好第 10 新
    expect(store.get('s49')).toBeUndefined(); // 刚好被裁
    expect(store.get('s0')).toBeUndefined();
  });

  it('0 = 不限制：写入 60 条一条不裁', () => {
    const store = new SessionHistoryStore(new FakeMemento(), makeClock(), { maxSessions: () => 0 });
    fill(store, 60);

    expect(store.list()).toHaveLength(60);
    expect(store.get('s0')).toBeDefined();
  });

  it('上限调小后立刻生效（getter 现读，无需重建实例）', () => {
    let limit = 50;
    const store = new SessionHistoryStore(new FakeMemento(), makeClock(), { maxSessions: () => limit });
    fill(store, 50);
    expect(store.list()).toHaveLength(50);

    limit = 5; // 模拟用户在设置里改小
    store.persist();
    expect(store.list()).toHaveLength(5);
    expect(store.get('s49')).toBeDefined();
  });

  it('非法值（NaN / 负数）回退到缺省，不会把历史清空', () => {
    const nan = new SessionHistoryStore(new FakeMemento(), makeClock(), { maxSessions: () => NaN });
    fill(nan, 5);
    expect(nan.list()).toHaveLength(5); // 5 < 50，不应被裁

    // 负数归一化为"不限"，同样不清空
    const neg = new SessionHistoryStore(new FakeMemento(), makeClock(), { maxSessions: () => -3 });
    fill(neg, 5);
    expect(neg.list()).toHaveLength(5);
  });

  it('读取时也裁剪：文件里已有超限历史，构造后就应收缩', () => {
    const memento = new FakeMemento();
    // 先按"不限"写入 60 条，模拟旧版本留下的超大历史
    fill(new SessionHistoryStore(memento, makeClock(), { maxSessions: () => 0 }), 60);

    // 新实例按上限 10 读取 → 构造即裁剪（不必等到下一次写入）
    const reopened = new SessionHistoryStore(memento, makeClock(), { maxSessions: () => 10 });
    expect(reopened.list()).toHaveLength(10);
    expect(reopened.get('s59')).toBeDefined();
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

describe('FileMemento：历史外置到文件（daemon 重启 / 换机持久）', () => {
  const base = path.join(
    os.tmpdir(),
    `dsh-history-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );

  afterAll(() => {
    try {
      fs.rmSync(base, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('跨实例往返：写文件后新实例从同一文件恢复，数据一致', async () => {
    const file = path.join(base, '.dsh', 'history.json');
    const memento = new FileMemento(file);
    const first = new SessionHistoryStore(memento, makeClock());
    first.appendUser('s1', '问题A');
    first.appendAssistantDelta('s1', '回答A');
    first.finishAssistant('s1');
    first.endSession('s1');
    await memento.flush();

    // 等价于 daemon 重启后新起存储实例：仅凭文件即可恢复
    const second = new SessionHistoryStore(new FileMemento(file), makeClock());
    expect(second.list()).toHaveLength(1);
    expect(second.get('s1')!.messages.map((m) => m.text)).toEqual(['问题A', '回答A']);
    expect(second.get('s1')!.endedAt).toBeDefined();
  });

  it('目录不存在时自动创建，文件真实落盘', async () => {
    const file = path.join(base, 'nested', 'dir', 'history.json');
    const memento = new FileMemento(file);
    const store = new SessionHistoryStore(memento, makeClock());
    store.appendUser('s2', '持久化');
    store.persist();
    await memento.flush();
    expect(fs.existsSync(file)).toBe(true);
  });

  it('损坏 JSON 安全回退为空', () => {
    const file = path.join(base, 'bad.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'garbage-not-json');
    const store = new SessionHistoryStore(new FileMemento(file), makeClock());
    expect(store.list()).toEqual([]);
  });

  it('无文件路径（无工作区降级）时不落盘，内存仍可用', () => {
    const store = new SessionHistoryStore(new FileMemento(''), makeClock());
    store.appendUser('s3', '不落盘');
    store.persist();
    expect(store.list()).toHaveLength(1);
    expect(store.get('s3')!.messages[0].text).toBe('不落盘');
  });
});