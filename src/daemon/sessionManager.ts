/**
 * 会话状态机与事件缓冲（P1.1 / P1.2 / P1.5）。
 *
 * 纯逻辑模块，不依赖 ws：
 *  - 每个会话独立维护 state（idle/running/pending_approval/pending_patch）
 *  - 事件环形缓冲：断线后经 session.resume 重放
 *  - 审批/补丁挂起项：强校验归属 + expiresAt 过期自动按拒绝
 *  - 并发：同一会话串行（begin 拒绝），不同会话互不影响
 */
import {
  ERROR_CODES,
  EventApprovalRequest,
  EventFilePatchPending,
  EventPlanRequest,
  SessionResumeResult,
  SessionState,
} from '../../shared/protocol';

export interface BufferedEvent {
  method: string;
  params: unknown;
  ts: number;
}

interface PendingItem {
  id: string;
  expiresAt: number;
  resolve: (accepted: boolean) => void;
  timer: NodeJS.Timeout;
  /** 到点未响应：自动按拒绝解析，条目保留为"已过期"，供 respond 检测 */
  expired?: boolean;
}

export interface ApprovalSnapshot {
  approvalId: string;
  expiresAt: number;
  tool: string;
  input: Record<string, unknown>;
  risk: 'low' | 'medium' | 'high';
  reason: string;
}

export interface PatchSnapshot {
  patchId: string;
  expiresAt: number;
  path: string;
  oldContent?: string;
  newContent: string;
  description?: string;
}

/** P2-7 计划快照：断线重连后靠它把「待批准的计划」原样交还给用户。 */
export interface PlanSnapshot {
  planId: string;
  expiresAt: number;
  plan: string;
}

/** 挂起项类别（审批 / 补丁 / 计划）。三者的登记-响应-过期语义完全同构。 */
type PendingKind = 'approval' | 'patch' | 'plan';

/**
 * 是否处于「等用户决策」的挂起态。
 *
 * 收在一个判定里而不是各写一遍 `||`：新增一类挂起时，漏掉任何一处分支的后果都是
 * "取消后状态没退回 running""到点过期后状态卡住"这类难查的中间态。
 */
function isPendingState(state: SessionState): boolean {
  return state === 'pending_approval' || state === 'pending_patch' || state === 'pending_plan';
}

export const DEFAULT_APPROVAL_TTL_MS = 60_000;
/** 挂起项 TTL 可配范围：太短来不及看，太长等于让 Agent 干等 */
export const MIN_APPROVAL_TTL_MS = 10_000;
export const MAX_APPROVAL_TTL_MS = 60 * 60_000;

/**
 * 收敛外部声明的挂起项 TTL（initialize.capabilities.approvalTtlMs）。
 * 非数字 / 非正数回落到缺省 60s，越界钳制到 [10s, 60min]。
 */
export function clampApprovalTtlMs(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_APPROVAL_TTL_MS;
  return Math.min(MAX_APPROVAL_TTL_MS, Math.max(MIN_APPROVAL_TTL_MS, Math.round(n)));
}

export class Session {
  state: SessionState = 'idle';
  canceled = false;

  private buffer: BufferedEvent[] = [];
  private pendingApproval = new Map<string, PendingItem>();
  private pendingPatch = new Map<string, PendingItem>();
  private pendingPlan = new Map<string, PendingItem>();
  private approvalSnapshot: ApprovalSnapshot | null = null;
  private patchSnapshot: PatchSnapshot | null = null;
  private planSnapshot: PlanSnapshot | null = null;
  /** P2-7：批准计划时用户附带的补充意见（仅"批准"时留存） */
  private planNote: string | null = null;
  /** P2 编辑后应用：patchId -> 用户编辑后的完整内容（accept 时带回，写盘覆盖 newContent） */
  private patchContent = new Map<string, string>();
  /** P0-1：已由客户端应用到编辑器缓冲区的 patchId（agent 侧须跳过写盘） */
  private patchApplyInEditor = new Set<string>();
  /** P0-3 取消订阅者：Agent 注册的在途请求中断回调（如 abort 在途 fetch） */
  private cancelHooks = new Set<() => void>();

  /**
   * 最近一次活动时刻（空闲回收依据）。
   *
   * 只在 `emit()` 里推进：一次运行的每一步都会产生事件，收尾必然发出 `session.ended`，
   * 所以"最后一个事件的时间"就等于"这个会话最后一次真正干活的时间"。
   * 挂起中的会话（等审批）虽然可能长时间没有新事件，但它 state ≠ idle，本就不参与回收。
   */
  lastActivityAt = Date.now();

  /** 迹线步号序列（`nextStep` 自增）。随会话一起被回收，正是"会话内递增"想要的语义。 */
  private stepSeq = 0;

  /** 事件投递钩子：由 server 绑定到当前连接的 ws；断线时不投递但缓冲仍记录 */
  deliver: (method: string, params: unknown) => void = () => {};

  constructor(
    readonly id: string,
    readonly workspaceRoot: string,
    private readonly maxBuffer = 2000
  ) {}

  // ------------------------------------------------------------------ 事件

  emit(method: string, params: unknown): void {
    this.lastActivityAt = Date.now();
    this.buffer.push({ method, params, ts: Date.now() });
    if (this.buffer.length > this.maxBuffer) {
      this.buffer.splice(0, this.buffer.length - this.maxBuffer);
    }
    this.deliver(method, params);
  }

  /** 重放全部缓冲事件（session.resume 用），并返回当前挂起快照。 */
  resume(): SessionResumeResult {
    for (const e of this.buffer) {
      this.deliver(e.method, e.params);
    }
    const result: SessionResumeResult = {
      sessionId: this.id,
      state: this.state,
    };
    if (this.approvalSnapshot) {
      const a = this.approvalSnapshot;
      result.pendingApproval = {
        approvalId: a.approvalId,
        expiresAt: a.expiresAt,
        tool: a.tool,
        input: a.input,
        risk: a.risk,
        reason: a.reason,
      };
    }
    if (this.patchSnapshot) {
      const p = this.patchSnapshot;
      result.pendingPatch = {
        patchId: p.patchId,
        expiresAt: p.expiresAt,
        path: p.path,
        oldContent: p.oldContent,
        newContent: p.newContent,
        description: p.description,
      };
    }
    if (this.planSnapshot) {
      const pl = this.planSnapshot;
      result.pendingPlan = { planId: pl.planId, expiresAt: pl.expiresAt, plan: pl.plan };
    }
    return result;
  }

  // ------------------------------------------------------------------ 生命周期

  /** 同一会话并发保护：仅 idle 可开始新运行。 */
  canStart(): boolean {
    return this.state === 'idle';
  }

  begin(): void {
    this.state = 'running';
    this.canceled = false;
  }

  cancel(): void {
    this.canceled = true;
    this.rejectAllPending();
    // 挂起项被整体按"拒绝"解析掉了，快照就必须跟着清 —— 否则 `session.resume` 在
    // 「已取消、Agent 还没收尾」这段窗口里会交还一个再也答不了的挂起项给 UI。
    // （三种挂起项同此：状态、Promise、快照必须同时归位。）
    this.approvalSnapshot = null;
    this.patchSnapshot = null;
    this.planSnapshot = null;
    if (isPendingState(this.state)) {
      this.state = 'running'; // Agent 会在下一轮检查 canceled 并收尾
    }
    // P0-3：同步触发在途请求中断（在 rejectAllPending 之后，避免回调里再观察挂起态）
    this.fireCancelHooks();
  }

  /**
   * P0-3 注册取消回调；返回取消订阅函数。
   *
   * 会话已处于取消态时**立即同步触发一次**——否则「先取消、后注册」的竞态会让
   * Agent 错过事件、在途请求无人中断。
   */
  onCancel(fn: () => void): () => void {
    if (this.canceled) {
      fn();
      return () => {};
    }
    this.cancelHooks.add(fn);
    return () => this.cancelHooks.delete(fn);
  }

  /** 触发全部取消回调；回调抛错不影响其它回调，也不向调用方冒泡。 */
  private fireCancelHooks(): void {
    for (const fn of [...this.cancelHooks]) {
      try {
        fn();
      } catch {
        /* 取消回调失败不应阻断取消流程 */
      }
    }
  }

  end(): void {
    this.state = 'idle';
    this.approvalSnapshot = null;
    this.patchSnapshot = null;
    this.planSnapshot = null;
    this.planNote = null;
    this.patchContent.clear();
    this.patchApplyInEditor.clear();
    this.rejectAllPending();
    // 会话收尾：清空取消订阅，避免上一轮的钩子泄漏到下一轮
    this.cancelHooks.clear();
  }

  isCanceled(): boolean {
    return this.canceled;
  }

  /** 取下一个迹线步号。**会话内**单调递增（PROTOCOL §6），多会话并发时互不干扰。 */
  nextStep(): number {
    return ++this.stepSeq;
  }

  // ------------------------------------------------------------------ 审批

  registerApproval(params: EventApprovalRequest, ttlMs = DEFAULT_APPROVAL_TTL_MS): Promise<boolean> {
    this.approvalSnapshot = {
      approvalId: params.approvalId,
      expiresAt: params.expiresAt ?? Date.now() + ttlMs,
      tool: params.tool,
      input: params.input,
      risk: params.risk,
      reason: params.reason,
    };
    this.state = 'pending_approval';
    return this.registerPending('approval', this.approvalSnapshot.approvalId, this.approvalSnapshot.expiresAt);
  }

  registerPatch(params: EventFilePatchPending, ttlMs = DEFAULT_APPROVAL_TTL_MS): Promise<boolean> {
    this.patchSnapshot = {
      patchId: params.patchId,
      expiresAt: Date.now() + ttlMs,
      path: params.path,
      oldContent: params.oldContent,
      newContent: params.newContent,
      description: params.description,
    };
    this.state = 'pending_patch';
    return this.registerPending('patch', this.patchSnapshot.patchId, this.patchSnapshot.expiresAt);
  }

  respondApproval(approvalId: string, approved: boolean): 'ok' | 'expired' | 'not_found' {
    const r = this.respondPending('approval', approvalId, approved);
    if (r === 'ok') {
      this.approvalSnapshot = null;
      this.state = 'running';
    }
    return r;
  }

  /** P2-7：登记一份待用户批准的计划。过期语义与审批完全一致（到点按"拒绝"处理）。 */
  registerPlan(params: EventPlanRequest, ttlMs = DEFAULT_APPROVAL_TTL_MS): Promise<boolean> {
    this.planSnapshot = {
      planId: params.planId,
      expiresAt: params.expiresAt ?? Date.now() + ttlMs,
      plan: params.plan,
    };
    this.planNote = null; // 上一轮的补充意见不跨计划残留
    this.state = 'pending_plan';
    return this.registerPending('plan', this.planSnapshot.planId, this.planSnapshot.expiresAt);
  }

  respondPlan(planId: string, approved: boolean, note?: string): 'ok' | 'expired' | 'not_found' {
    const r = this.respondPending('plan', planId, approved);
    if (r === 'ok') {
      // 只在"批准"时留存补充意见：拒绝时那段文字对执行阶段没有意义。
      this.planNote = approved && typeof note === 'string' && note.trim() ? note : null;
      this.planSnapshot = null;
      this.state = 'running';
    }
    return r;
  }

  /** P2-7：用户在批准计划时附带的补充意见（无则 undefined）。 */
  getPlanNote(): string | undefined {
    return this.planNote ?? undefined;
  }

  /** 当前挂起审批的输入参数（B1 信任记忆用：approval.respond 带 trust 时取命令入白名单）。 */
  getPendingApprovalInput(): Record<string, unknown> | null {
    return this.approvalSnapshot ? { ...this.approvalSnapshot.input } : null;
  }

  respondPatch(
    patchId: string,
    accept: boolean,
    content?: string,
    applyInEditor?: boolean
  ): 'ok' | 'expired' | 'not_found' {
    const r = this.respondPending('patch', patchId, accept);
    if (r === 'ok') {
      // P2 编辑后应用：accept 时暂存用户编辑后内容，供 agent 写盘读取
      if (accept && typeof content === 'string') {
        this.patchContent.set(patchId, content);
      } else {
        this.patchContent.delete(patchId);
      }
      // P0-1：客户端已把改动应用到编辑器缓冲区，agent 侧据此跳过写盘
      if (accept && applyInEditor) {
        this.patchApplyInEditor.add(patchId);
      } else {
        this.patchApplyInEditor.delete(patchId);
      }
      this.patchSnapshot = null;
      this.state = 'running';
    }
    return r;
  }

  /** P2 编辑后应用：agent 写盘前读取用户编辑后的内容（无则返回 undefined，用原始 newContent）。 */
  getPatchContent(patchId: string): string | undefined {
    return this.patchContent.get(patchId);
  }

  /**
   * P0-1：本补丁是否已由客户端应用到编辑器缓冲区（accept 时带 `applyInEditor`）。
   * 为 true 时 agent 不得再写磁盘——写盘会与缓冲区内容分叉。
   */
  getPatchApplyInEditor(patchId: string): boolean {
    return this.patchApplyInEditor.has(patchId);
  }

  // ------------------------------------------------------------------ 内部

  private pendingMapOf(kind: PendingKind): Map<string, PendingItem> {
    if (kind === 'approval') return this.pendingApproval;
    return kind === 'patch' ? this.pendingPatch : this.pendingPlan;
  }

  private registerPending(kind: PendingKind, id: string, expiresAt: number): Promise<boolean> {
    const map = this.pendingMapOf(kind);
    // 每次登记新条目时顺手扫掉同类型的**已过期**条目（P1-7 的最小修法）。
    //
    // 不变量：到点未响应的条目要保留一小会儿 —— 此时 `respond` 必须还能回 `expired`（而不是
    // `not_found`），前端才知道自己点晚了一步。清扫只发生在"又登记了新条目"这一刻，
    // 上面那个语义窗口因此完整保留；而被清掉的条目此后 respond 得到 `not_found`，同样可解释。
    //
    // 刻意**不加第二个定时器**做延迟清理：一个悬着的 setTimeout 会把测试进程拖住
    // （真实定时器环境下 vitest 会因此迟迟不退出），而不清理的代价只是几十字节。
    // 真正让内存有界的是会话级回收（见 SessionManager.prune），不是这里。
    this.sweepExpiredPending(map);
    return new Promise<boolean>((resolve) => {
      const entry: PendingItem = {
        id,
        expiresAt,
        resolve,
        timer: setTimeout(() => {
          // 到点未响应：自动按拒绝解析；条目保留标记 expired，供 respond 返回 'expired'
          entry.expired = true;
          entry.resolve(false);
          if (kind === 'approval') this.approvalSnapshot = null;
          else if (kind === 'patch') this.patchSnapshot = null;
          else this.planSnapshot = null;
          if (isPendingState(this.state)) {
            this.state = 'running';
          }
        }, Math.max(0, expiresAt - Date.now())),
      };
      map.set(id, entry);
    });
  }

  /** 清掉同类型中已过期（定时器已触发并解析）的挂起项；未到期的原样保留。 */
  private sweepExpiredPending(map: Map<string, PendingItem>): void {
    for (const [key, item] of [...map]) {
      if (item.expired) map.delete(key);
    }
  }

  private respondPending(
    kind: PendingKind,
    id: string,
    accepted: boolean
  ): 'ok' | 'expired' | 'not_found' {
    const map = this.pendingMapOf(kind);
    const entry = map.get(id);
    if (!entry) return 'not_found';
    map.delete(id);
    clearTimeout(entry.timer);
    if (entry.expired || Date.now() > entry.expiresAt) {
      return 'expired';
    }
    entry.resolve(accepted);
    return 'ok';
  }

  private rejectAllPending(): void {
    for (const map of [this.pendingApproval, this.pendingPatch, this.pendingPlan]) {
      for (const p of map.values()) {
        clearTimeout(p.timer);
        p.resolve(false);
      }
      map.clear();
    }
  }
}

/**
 * 空闲会话保留窗口（P1-1）。
 *
 * 为什么不能"会话一结束就删"：断线重连要靠 `session.resume` 拿回事件缓冲与挂起快照，
 * 窗口重载 / 网络抖动 / 短暂合盖都可能发生在这个窗口内。10 分钟足够覆盖这些场景，
 * 又不至于让内存无界增长。会话历史另有落盘（`.dsh/history.json`），回收的只是内存态。
 */
export const DEFAULT_IDLE_SESSION_TTL_MS = 10 * 60_000;

/** 空闲会话数量上限：超出时按闲置时间从久到近淘汰。 */
export const DEFAULT_MAX_IDLE_SESSIONS = 50;

export interface PruneResult {
  /** 因空闲超时被回收的会话 id */
  expired: string[];
  /** 因超出数量上限被 LRU 淘汰的会话 id */
  evicted: string[];
}

/** 会话注册表：id -> Session。 */
export class SessionManager {
  private sessions = new Map<string, Session>();

  constructor(
    private readonly defaultWorkspaceRoot: string,
    private readonly retention: { idleTtlMs?: number; maxIdle?: number } = {}
  ) {}

  create(id?: string): Session {
    const sid = id ?? `sess_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const session = new Session(sid, this.defaultWorkspaceRoot);
    this.sessions.set(sid, session);
    // 会话只增不减是"内存单调增长"的根源，而**新建正发生在增长的那一刻** ——
    // 所以把回收挂在这里：不需要额外定时器（定时器要管生命周期、还会拖住测试进程），
    // 也不依赖调用方记得调 prune。
    this.prune();
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  delete(id: string): void {
    this.sessions.delete(id);
  }

  /**
   * 回收空闲会话（P1-1）。
   *
   * 背景：`Session` 每个常驻 ≤2000 条事件缓冲 + patchContent 快照，而 `delete()` 此前
   * **从未被调用过**，daemon 跨天长跑时内存单调增长。
   *
   * 两条**永不回收**的红线：`running` 与 `pending_*`（等审批 / 等补丁）的会话 ——
   * 它们有在途工具调用或待用户决策的挂起项，删掉就是丢用户的操作。故只淘汰 `idle` 的。
   *
   * @param now 注入"当前时刻"便于单测直接构造时间差，不必 sleep
   * @returns 被回收的会话 id（供日志与断言）
   */
  prune(now = Date.now()): PruneResult {
    const ttl = this.retention.idleTtlMs ?? DEFAULT_IDLE_SESSION_TTL_MS;
    const maxIdle = this.retention.maxIdle ?? DEFAULT_MAX_IDLE_SESSIONS;

    const expired: string[] = [];
    if (ttl > 0) {
      for (const s of [...this.sessions.values()]) {
        if (s.state !== 'idle') continue;
        if (now - s.lastActivityAt > ttl) {
          this.sessions.delete(s.id);
          expired.push(s.id);
        }
      }
    }

    const evicted: string[] = [];
    if (maxIdle > 0) {
      const idle = [...this.sessions.values()]
        .filter((s) => s.state === 'idle')
        .sort((a, b) => a.lastActivityAt - b.lastActivityAt); // 最久未活动的排最前
      while (idle.length > maxIdle) {
        const victim = idle.shift();
        if (!victim) break;
        this.sessions.delete(victim.id);
        evicted.push(victim.id);
      }
    }

    return { expired, evicted };
  }

  /** 当前会话总数（回收效果的观测点）。 */
  size(): number {
    return this.sessions.size;
  }

  /** 当前处于运行/挂起状态的会话数（maxConcurrency 判定用）。 */
  runningCount(): number {
    let n = 0;
    for (const s of this.sessions.values()) {
      if (s.state !== 'idle') n++;
    }
    return n;
  }
}

export function errorCodeOf(err: unknown): number | undefined {
  return (err as { code?: number } | null)?.code ?? undefined;
}

export { ERROR_CODES };
