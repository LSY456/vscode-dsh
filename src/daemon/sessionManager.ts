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

export const DEFAULT_APPROVAL_TTL_MS = 60_000;

export class Session {
  state: SessionState = 'idle';
  canceled = false;

  private buffer: BufferedEvent[] = [];
  private pendingApproval = new Map<string, PendingItem>();
  private pendingPatch = new Map<string, PendingItem>();
  private approvalSnapshot: ApprovalSnapshot | null = null;
  private patchSnapshot: PatchSnapshot | null = null;

  /** 事件投递钩子：由 server 绑定到当前连接的 ws；断线时不投递但缓冲仍记录 */
  deliver: (method: string, params: unknown) => void = () => {};

  constructor(
    readonly id: string,
    readonly workspaceRoot: string,
    private readonly maxBuffer = 2000
  ) {}

  // ------------------------------------------------------------------ 事件

  emit(method: string, params: unknown): void {
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
    if (this.state === 'pending_approval' || this.state === 'pending_patch') {
      this.state = 'running'; // Agent 会在下一轮检查 canceled 并收尾
    }
  }

  end(): void {
    this.state = 'idle';
    this.approvalSnapshot = null;
    this.patchSnapshot = null;
    this.rejectAllPending();
  }

  isCanceled(): boolean {
    return this.canceled;
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

  /** 当前挂起审批的输入参数（B1 信任记忆用：approval.respond 带 trust 时取命令入白名单）。 */
  getPendingApprovalInput(): Record<string, unknown> | null {
    return this.approvalSnapshot ? { ...this.approvalSnapshot.input } : null;
  }

  respondPatch(patchId: string, accept: boolean): 'ok' | 'expired' | 'not_found' {
    const r = this.respondPending('patch', patchId, accept);
    if (r === 'ok') {
      this.patchSnapshot = null;
      this.state = 'running';
    }
    return r;
  }

  // ------------------------------------------------------------------ 内部

  private registerPending(
    kind: 'approval' | 'patch',
    id: string,
    expiresAt: number
  ): Promise<boolean> {
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
          else this.patchSnapshot = null;
          if (this.state === 'pending_approval' || this.state === 'pending_patch') {
            this.state = 'running';
          }
        }, Math.max(0, expiresAt - Date.now())),
      };
      const map = kind === 'approval' ? this.pendingApproval : this.pendingPatch;
      map.set(id, entry);
    });
  }

  private respondPending(
    kind: 'approval' | 'patch',
    id: string,
    accepted: boolean
  ): 'ok' | 'expired' | 'not_found' {
    const map = kind === 'approval' ? this.pendingApproval : this.pendingPatch;
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
    for (const p of this.pendingApproval.values()) {
      clearTimeout(p.timer);
      p.resolve(false);
    }
    this.pendingApproval.clear();
    for (const p of this.pendingPatch.values()) {
      clearTimeout(p.timer);
      p.resolve(false);
    }
    this.pendingPatch.clear();
  }
}

/** 会话注册表：id -> Session。 */
export class SessionManager {
  private sessions = new Map<string, Session>();

  constructor(private readonly defaultWorkspaceRoot: string) {}

  create(id?: string): Session {
    const sid = id ?? `sess_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const session = new Session(sid, this.defaultWorkspaceRoot);
    this.sessions.set(sid, session);
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  delete(id: string): void {
    this.sessions.delete(id);
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
