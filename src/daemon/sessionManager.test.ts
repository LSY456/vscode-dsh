import { describe, expect, it } from 'vitest';
import {
  clampApprovalTtlMs,
  DEFAULT_APPROVAL_TTL_MS,
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
