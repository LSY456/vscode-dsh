import { describe, expect, it } from 'vitest';
import {
  clampApprovalTtlMs,
  DEFAULT_APPROVAL_TTL_MS,
  DEFAULT_IDLE_SESSION_TTL_MS,
  DEFAULT_MAX_IDLE_SESSIONS,
  MAX_APPROVAL_TTL_MS,
  MIN_APPROVAL_TTL_MS,
  Session,
  SessionManager,
} from './sessionManager';
import { sleep } from './test-utils';

describe('clampApprovalTtlMs（挂起项超时可配，越界收敛）', () => {
  it('缺省：非法值回落到 60s', () => {
    expect(clampApprovalTtlMs(undefined)).toBe(DEFAULT_APPROVAL_TTL_MS);
    expect(clampApprovalTtlMs(0)).toBe(DEFAULT_APPROVAL_TTL_MS);
    expect(clampApprovalTtlMs(-5)).toBe(DEFAULT_APPROVAL_TTL_MS);
    expect(clampApprovalTtlMs('abc')).toBe(DEFAULT_APPROVAL_TTL_MS);
    expect(clampApprovalTtlMs(NaN)).toBe(DEFAULT_APPROVAL_TTL_MS);
  });

  it('区间内原样保留，越界钳制（太短会来不及看，太长等于让 Agent 干等）', () => {
    expect(clampApprovalTtlMs(300_000)).toBe(300_000);
    expect(clampApprovalTtlMs(1_000)).toBe(MIN_APPROVAL_TTL_MS);
    expect(clampApprovalTtlMs(99 * 3600_000)).toBe(MAX_APPROVAL_TTL_MS);
  });
});

function makeApprovalParams(id: string) {
  return {
    sessionId: 's1',
    approvalId: id,
    tool: 'bash_execute',
    input: { command: 'rm -rf x' },
    risk: 'high' as const,
    reason: '高危',
    expiresAt: Date.now() + 60_000,
  };
}

function makePatchParams(id: string) {
  return {
    sessionId: 's1',
    patchId: id,
    path: '/ws/a.txt',
    oldContent: 'old',
    newContent: 'new',
    description: '补丁',
  };
}

describe('Session 生命周期与并发保护', () => {
  it('idle 可 begin，running 后 canStart 为 false（同一会话串行）', () => {
    const s = new Session('s1', '/ws');
    expect(s.canStart()).toBe(true);
    s.begin();
    expect(s.canStart()).toBe(false);
    s.end();
    expect(s.canStart()).toBe(true);
  });

  it('不同会话互不影响（多会话并发）', () => {
    const a = new Session('a', '/ws');
    const b = new Session('b', '/ws');
    a.begin();
    expect(a.canStart()).toBe(false);
    expect(b.canStart()).toBe(true);
  });

  it('cancel 置 canceled 标记并拒绝挂起项', async () => {
    const s = new Session('s1', '/ws');
    s.begin();
    const approvalPromise = s.registerApproval(makeApprovalParams('ap1'));
    s.cancel();
    expect(s.isCanceled()).toBe(true);
    expect(await approvalPromise).toBe(false);
    expect(s.state).toBe('running'); // cancel 将挂起态解为 running，由 Agent 收尾
  });
});

describe('Session 取消订阅（P0-3 中断在途请求）', () => {
  it('cancel 同步触发已注册回调（供 Agent abort 在途 fetch）', () => {
    const s = new Session('s1', '/ws');
    s.begin();
    let fired = 0;
    s.onCancel(() => fired++);
    expect(fired).toBe(0);
    s.cancel();
    expect(fired).toBe(1);
  });

  it('取消订阅后不再触发', () => {
    const s = new Session('s1', '/ws');
    s.begin();
    let fired = 0;
    const off = s.onCancel(() => fired++);
    off();
    s.cancel();
    expect(fired).toBe(0);
  });

  it('多个订阅者都被触发（且互不阻断）', () => {
    const s = new Session('s1', '/ws');
    s.begin();
    const order: string[] = [];
    s.onCancel(() => order.push('a'));
    s.onCancel(() => {
      throw new Error('boom'); // 一个回调抛错不应阻断其它
    });
    s.onCancel(() => order.push('c'));
    s.cancel();
    expect(order).toEqual(['a', 'c']);
  });

  it('已取消后再注册 -> 立即同步触发（消除先取消后注册的竞态）', () => {
    const s = new Session('s1', '/ws');
    s.begin();
    s.cancel();
    let fired = 0;
    s.onCancel(() => fired++);
    expect(fired).toBe(1);
  });

  it('end() 清空订阅，避免钩子泄漏到下一轮', () => {
    const s = new Session('s1', '/ws');
    s.begin();
    let fired = 0;
    s.onCancel(() => fired++);
    s.end();
    s.begin();
    s.cancel();
    expect(fired).toBe(0);
  });
});

describe('审批强校验（P1.1）', () => {
  it('有效期内 respond -> ok，且 promise 按 approved 解析', async () => {
    const s = new Session('s1', '/ws');
    const p = s.registerApproval(makeApprovalParams('ap1'));
    const r = s.respondApproval('ap1', true);
    expect(r).toBe('ok');
    expect(await p).toBe(true);
    expect(s.state).toBe('running');
  });

  it('过期后 respond -> expired，且 promise 按拒绝解析', async () => {
    const s = new Session('s1', '/ws');
    const p = s.registerApproval({ ...makeApprovalParams('ap1'), expiresAt: Date.now() + 30 }, 30);
    await sleep(60);
    const r = s.respondApproval('ap1', true);
    expect(r).toBe('expired');
    expect(await p).toBe(false);
  });

  it('不响应时到点自动按拒绝解析并解除挂起；事后 respond 报 expired', async () => {
    const s = new Session('s1', '/ws');
    const p = s.registerApproval({ ...makeApprovalParams('ap1'), expiresAt: Date.now() + 30 }, 30);
    expect(await p).toBe(false); // 30ms 后自动 resolve(false)
    expect(s.state).toBe('running');
    expect(s.respondApproval('ap1', true)).toBe('expired'); // 条目保留为已过期
  });

  it('未知 approvalId -> not_found', () => {
    const s = new Session('s1', '/ws');
    expect(s.respondApproval('nope', true)).toBe('not_found');
  });

  it('补丁：有效响应 ok / 过期 expired / 未知 not_found', async () => {
    const s = new Session('s1', '/ws');
    const p = s.registerPatch(makePatchParams('pt1'));
    expect(s.state).toBe('pending_patch');
    expect(s.respondPatch('pt1', true)).toBe('ok');
    expect(await p).toBe(true);

    const p2 = s.registerPatch(makePatchParams('pt2'), 30);
    await sleep(60);
    expect(s.respondPatch('pt2', true)).toBe('expired');
    expect(await p2).toBe(false);
    expect(s.respondPatch('pt3', true)).toBe('not_found');
  });

  it('P2 编辑后应用：accept 带 content 覆盖写盘内容，缺省/拒绝则不覆盖', () => {
    const s = new Session('s1', '/ws');
    s.registerPatch(makePatchParams('pt1'));
    // 响应前无覆盖内容
    expect(s.getPatchContent('pt1')).toBeUndefined();

    s.respondPatch('pt1', true, '用户编辑后的全文');
    expect(s.getPatchContent('pt1')).toBe('用户编辑后的全文');

    // 无 content 的 accept 不产生覆盖（agent 回退原始 newContent）
    s.end();
    s.registerPatch(makePatchParams('pt2'));
    s.respondPatch('pt2', true);
    expect(s.getPatchContent('pt2')).toBeUndefined();

    // 拒绝不覆盖
    s.end();
    s.registerPatch(makePatchParams('pt3'));
    s.respondPatch('pt3', false, '拒绝时忽略的内容');
    expect(s.getPatchContent('pt3')).toBeUndefined();
  });

  it('P0-1 应用到编辑器：accept 带 applyInEditor 才置位（agent 据此跳过写盘）', () => {
    const s = new Session('s1', '/ws');

    // 默认（未带标记）：daemon 仍需自行落盘
    s.registerPatch(makePatchParams('p1'));
    s.respondPatch('p1', true);
    expect(s.getPatchApplyInEditor('p1')).toBe(false);

    // 带标记：落地通路交给编辑器
    s.end();
    s.registerPatch(makePatchParams('p2'));
    s.respondPatch('p2', true, undefined, true);
    expect(s.getPatchApplyInEditor('p2')).toBe(true);

    // 拒绝时标记无意义，不应置位
    s.end();
    s.registerPatch(makePatchParams('p3'));
    s.respondPatch('p3', false, undefined, true);
    expect(s.getPatchApplyInEditor('p3')).toBe(false);

    // 未知 patchId 不置位
    expect(s.getPatchApplyInEditor('nope')).toBe(false);
  });

  it('P0-1 end() 清空"应用到编辑器"标记，不泄漏到下一轮', () => {
    const s = new Session('s1', '/ws');
    s.registerPatch(makePatchParams('p1'));
    s.respondPatch('p1', true, undefined, true);
    expect(s.getPatchApplyInEditor('p1')).toBe(true);
    s.end();
    expect(s.getPatchApplyInEditor('p1')).toBe(false);
  });
});

describe('事件缓冲与续跑（P1.2）', () => {
  it('emit 记录缓冲并可完整重放', () => {
    const s = new Session('s1', '/ws', 100);
    const replayed: string[] = [];
    s.deliver = (m) => replayed.push(m);
    s.emit('a', 1);
    s.emit('b', 2);
    replayed.length = 0;
    s.resume();
    expect(replayed).toEqual(['a', 'b']);
  });

  it('缓冲超上限时丢弃最旧事件', () => {
    const s = new Session('s1', '/ws', 3);
    s.emit('e1', 1);
    s.emit('e2', 2);
    s.emit('e3', 3);
    s.emit('e4', 4);
    const replayed: string[] = [];
    s.deliver = (m) => replayed.push(m);
    s.resume();
    expect(replayed).toEqual(['e2', 'e3', 'e4']);
  });

  it('挂起态续跑返回状态与审批快照', () => {
    const s = new Session('s1', '/ws');
    s.begin();
    s.registerApproval(makeApprovalParams('ap1'));
    const result = s.resume();
    expect(result.state).toBe('pending_approval');
    expect(result.pendingApproval?.approvalId).toBe('ap1');
    expect(result.pendingApproval?.tool).toBe('bash_execute');
    expect(result.pendingApproval?.input).toEqual({ command: 'rm -rf x' });
  });

  it('挂起态续跑返回补丁快照（含完整内容）', () => {
    const s = new Session('s1', '/ws');
    s.begin();
    s.registerPatch(makePatchParams('pt1'));
    const result = s.resume();
    expect(result.state).toBe('pending_patch');
    expect(result.pendingPatch?.patchId).toBe('pt1');
    expect(result.pendingPatch?.newContent).toBe('new');
  });
});

describe('SessionManager 注册表', () => {
  it('create/get/runningCount/delete', () => {
    const sm = new SessionManager('/ws');
    const a = sm.create();
    expect(sm.get(a.id)).toBe(a);
    expect(sm.runningCount()).toBe(0);
    a.begin();
    expect(sm.runningCount()).toBe(1);
    const b = sm.create();
    b.begin();
    expect(sm.runningCount()).toBe(2);
    sm.delete(a.id);
    expect(sm.get(a.id)).toBeUndefined();
    expect(sm.runningCount()).toBe(1);
  });
});

describe('Session.nextStep：步号是**会话内**单调（P1-8）', () => {
  it('同一会话内 1、2、3 递增', () => {
    const s = new Session('s1', '/ws');
    expect(s.nextStep()).toBe(1);
    expect(s.nextStep()).toBe(2);
    expect(s.nextStep()).toBe(3);
  });

  it('多会话并发时各自从 1 开始，互不干扰（不再全局漂移）', () => {
    const a = new Session('a', '/ws');
    const b = new Session('b', '/ws');
    expect(a.nextStep()).toBe(1);
    expect(a.nextStep()).toBe(2);
    expect(b.nextStep()).toBe(1);
    expect(a.nextStep()).toBe(3);
  });
});

describe('挂起项清扫：只清已过期条目，语义窗口优先（P1-7）', () => {
  it('到点未响应先保留（respond 报 expired），下一次登记时才被清掉', async () => {
    const s = new Session('s1', '/ws');
    s.begin();

    // ① 语义窗口：到点后 respond 必须还能区分"你点晚了一步"，而不是 not_found
    const p1 = s.registerApproval({ ...makeApprovalParams('ap1'), expiresAt: Date.now() + 20 }, 20);
    expect(await p1).toBe(false);
    expect(s.respondApproval('ap1', true)).toBe('expired');

    // ② 清扫：又登记新条目时，同类型的**已过期**条目被顺手删掉（内存才真正有界）
    const p2 = s.registerApproval({ ...makeApprovalParams('ap2'), expiresAt: Date.now() + 20 }, 20);
    expect(await p2).toBe(false);
    s.registerApproval(makeApprovalParams('ap3')); // 这一刻触发清扫
    expect(s.respondApproval('ap2', true)).toBe('not_found');

    expect(s.respondApproval('ap3', false)).toBe('ok');
  });

  it('未到期的挂起项不受清扫影响', () => {
    const s = new Session('s1', '/ws');
    const p1 = s.registerApproval(makeApprovalParams('ap1'));
    s.registerApproval(makeApprovalParams('ap2')); // 触发一次清扫
    expect(s.respondApproval('ap1', true)).toBe('ok');
    expect(s.respondApproval('ap2', true)).toBe('ok');
    void p1;
  });
});

describe('SessionManager.prune：空闲会话回收（P1-1 内存有界）', () => {
  const TTL = 1000;

  it('缺省保留窗口与上限是"够用又不无界"的两条线', () => {
    expect(DEFAULT_IDLE_SESSION_TTL_MS).toBe(10 * 60_000);
    expect(DEFAULT_MAX_IDLE_SESSIONS).toBe(50);
  });

  it('空闲超时被回收，窗口内的保留', () => {
    const sm = new SessionManager('/ws', { idleTtlMs: TTL, maxIdle: 0 });
    // 先建满再改时间戳：create() 自己会调 prune()，边建边改会让内部回收提前动手
    const old = sm.create('old');
    const fresh = sm.create('fresh');
    old.lastActivityAt = 0;
    fresh.lastActivityAt = TTL;

    const r = sm.prune(TTL + 1);
    expect(r.expired).toEqual(['old']);
    expect(sm.get('old')).toBeUndefined();
    expect(sm.get('fresh')).toBe(fresh);
    expect(sm.size()).toBe(1);
  });

  it('running / pending_* 会话永不回收（有在途调用或待用户决策）', () => {
    const sm = new SessionManager('/ws', { idleTtlMs: TTL, maxIdle: 0 });
    const running = sm.create('running');
    running.begin();
    const pending = sm.create('pending');
    pending.begin();
    pending.registerApproval(makeApprovalParams('ap1'));
    const idle = sm.create('idle');

    running.lastActivityAt = 0;
    pending.lastActivityAt = 0;
    idle.lastActivityAt = 0;

    const r = sm.prune(TTL + 1);
    expect(r.expired).toEqual(['idle']);
    expect(sm.get('running')).toBe(running);
    expect(sm.get('pending')).toBe(pending);
  });

  it('数量超上限时按最久未活动 LRU 淘汰', () => {
    const sm = new SessionManager('/ws', { idleTtlMs: 0, maxIdle: 2 });
    // 建的时候先保持 running：否则第 3 次 create() 的内部 prune 会提前淘汰掉一个
    const mk = (id: string, t: number) => {
      const s = sm.create(id);
      s.begin();
      s.lastActivityAt = t;
      return s;
    };
    const a = mk('a', 100);
    const b = mk('b', 200);
    const c = mk('c', 300);
    a.end();
    b.end();
    c.end();

    const r = sm.prune(1000);
    expect(r.evicted).toEqual(['a']); // 最久未活动者
    expect(sm.size()).toBe(2);
    expect(sm.get('a')).toBeUndefined();
    expect(sm.get('b')).toBe(b);
    expect(sm.get('c')).toBe(c);
  });

  it('idleTtlMs / maxIdle 为 0 表示该维度关闭（不误伤）', () => {
    const sm = new SessionManager('/ws', { idleTtlMs: 0, maxIdle: 0 });
    const s = sm.create('s');
    s.lastActivityAt = 0;
    expect(sm.prune(999_999_999)).toEqual({ expired: [], evicted: [] });
    expect(sm.get('s')).toBe(s);
  });
});

describe('Plan 挂起项（P2-7：计划与审批同构，但语义上独立）', () => {
  function makePlan(id: string) {
    return { sessionId: 's1', planId: id, plan: '## 计划\n1. 改 a.ts', expiresAt: Date.now() + 60_000 };
  }

  it('登记后进入 pending_plan，批准后回到 running', async () => {
    const s = new Session('s1', '/ws');
    const p = s.registerPlan(makePlan('p1'));
    expect(s.state).toBe('pending_plan');

    expect(s.respondPlan('p1', true)).toBe('ok');
    await expect(p).resolves.toBe(true);
    expect(s.state).toBe('running');
  });

  it('resume 时把待批准的计划原样交还（断线重连后用户还能批）', () => {
    const s = new Session('s1', '/ws');
    s.deliver = () => {};
    void s.registerPlan(makePlan('p1'));

    const r = s.resume();
    expect(r.state).toBe('pending_plan');
    expect(r.pendingPlan?.planId).toBe('p1');
    expect(r.pendingPlan?.plan).toContain('改 a.ts');
  });

  it('补充意见只在"批准"时留存（拒绝时那段文字对执行阶段没有意义）', async () => {
    const s = new Session('s1', '/ws');

    const approved = s.registerPlan(makePlan('p1'));
    s.respondPlan('p1', true, '  第 2 步别动 b.ts  ');
    await approved;
    expect(s.getPlanNote()).toBe('  第 2 步别动 b.ts  ');

    const rejected = s.registerPlan(makePlan('p2'));
    s.respondPlan('p2', false, '不同意');
    await rejected;
    expect(s.getPlanNote()).toBeUndefined();
  });

  it('登记新计划会清掉上一轮的补充意见（不跨计划残留）', async () => {
    const s = new Session('s1', '/ws');
    const first = s.registerPlan(makePlan('p1'));
    s.respondPlan('p1', true, '加个日志');
    await first;
    expect(s.getPlanNote()).toBe('加个日志');

    void s.registerPlan(makePlan('p2'));
    expect(s.getPlanNote()).toBeUndefined();
  });

  it('取消会让挂起中的计划按"不同意"解析（不留悬空 Promise）', async () => {
    const s = new Session('s1', '/ws');
    const p = s.registerPlan(makePlan('p1'));
    s.cancel();
    await expect(p).resolves.toBe(false);
    expect(s.state).toBe('running'); // 交还给 Agent 去走取消收尾
    expect(s.resume().pendingPlan).toBeUndefined();
  });

  it('重复/未知 planId：not_found；已过期的返回 expired 而不是 not_found', async () => {
    const s = new Session('s1', '/ws');
    expect(s.respondPlan('nope', true)).toBe('not_found');

    const p = s.registerPlan({ ...makePlan('p1'), expiresAt: Date.now() - 1 });
    await p;
    // 到点未响应：条目仍保留标记，respond 才能回 expired（用户才知道自己是"点晚了"）
    expect(s.respondPlan('p1', true)).toBe('expired');
    expect(s.respondPlan('p1', true)).toBe('not_found');
  });

  it('end() 清掉计划快照与补充意见', async () => {
    const s = new Session('s1', '/ws');
    const p = s.registerPlan(makePlan('p1'));
    s.respondPlan('p1', true, '备注');
    await p;
    s.end();
    expect(s.getPlanNote()).toBeUndefined();
    expect(s.resume().pendingPlan).toBeUndefined();
    expect(s.state).toBe('idle');
  });
});
