/**
 * daemon 安全边界纯函数（P1-17）。
 *
 * `server.ts` 是安全边界：握手鉴权 / 浏览器 Origin 拒绝 / 能力收敛 / 挂起项错误码映射。
 * 这几段判定原先全部内联在 `startDaemonServer()` 里，只能靠端到端 smoke **间接**覆盖 ——
 * 改错不会立刻变红，而这恰恰是最不能出错的一段。
 *
 * 这里抽的是**判定**，不是 IO：`verifyHandshake` 只吃 `{ authorization, origin }` 与 token，
 * 不碰 socket。因此可以在单测里离线穷举边界（空 token、大小写、前缀伪造、带 Origin……），
 * 不必起真服务器。抽出的函数必须是纯的，含副作用的一律留在 `server.ts`。
 */
import { AgentCapabilities } from './agent';
import { ERROR_CODES } from '../../shared/protocol';
import { assertPathInside } from './paths';
import { clampApprovalTtlMs } from './sessionManager';

// ---------------------------------------------------------------------------
// 握手
// ---------------------------------------------------------------------------

/** 握手判定所需的输入（从 `http.IncomingMessage` 摘出，只要这两项）。 */
export interface HandshakeInfo {
  /** 原始 Authorization 头（含 `Bearer ` 前缀）；缺失时为 undefined / 空串。 */
  authorization?: string | null;
  /** 浏览器请求携带的 Origin；扩展宿主（Node ws 客户端）不携带。空串视为不携带。 */
  origin?: string | null;
}

/**
 * 握手放行判定：Authorization 必须**精确等于** `Bearer <token>`，且**不得**携带 Origin。
 *
 * - **Origin 非空即拒绝**：浏览器发起的 WebSocket 一律带 Origin，而扩展宿主用的 Node
 *   `ws` 客户端不带。本机任意页面都能访问 127.0.0.1，若不拒 Origin，一个被注入的网页
 *   就能连上 daemon 发请求（CSWSH，跨站 WebSocket 劫持）。这是本函数存在的主要理由。
 * - **token 用 `===` 精确比对**：不 trim、不忽略大小写、不接受 `Bearer` 之外的 scheme。
 *   任何"宽容一点"的解析都在把鉴权面放大成可探测面 —— 判定要么过、要么不过，没有第三种。
 * - 顺序无关紧要（两个条件都必须为真），但先判 token 再判 Origin 与旧实现一致。
 */
export function verifyHandshake(info: HandshakeInfo, token: string): boolean {
  const auth = info.authorization ?? '';
  if (auth !== `Bearer ${token}`) return false;
  const origin = info.origin ?? '';
  return origin === '';
}

// ---------------------------------------------------------------------------
// 能力收敛
// ---------------------------------------------------------------------------

/** 连接级能力：与 `ConnectionRuntime.capabilities` 同形。 */
export type NormalizedCapabilities = Required<AgentCapabilities> & { maxConcurrency: number };

/** initialize 里客户端声明的能力（全部可缺省，字段类型故意放宽为 unknown 以便校验）。 */
export interface CapabilityDeclaration {
  allowedTools?: unknown;
  allowedDirs?: unknown;
  maxConcurrency?: unknown;
  approvalTtlMs?: unknown;
}

export interface NormalizedDeclaration {
  capabilities: NormalizedCapabilities;
  /**
   * 收敛后的挂起项 TTL；`null` = **客户端没声明**，调用方应保持现状（不要覆盖已有值）。
   * 与 `capabilities` 分列是因为二者的"缺省"语义不同：能力缺省即空，TTL 缺省即不改。
   */
  approvalTtlMs: number | null;
}

/**
 * 把 initialize 声明的能力收敛成连接级运行状态。
 *
 * 白名单缺省为空 = **不额外限制**（由 Agent 侧解释该语义），这与旧实现一致。字段类型非法
 * （该给数组却给了字符串等）时按"未声明"处理 —— 不新增一种"拒绝 initialize"的语义，
 * 因为能力是本连接的**自我约束**，声明畸形只会让该客户端自己失去约束，不影响其他连接。
 */
export function normalizeCapabilities(input?: CapabilityDeclaration | null): NormalizedCapabilities {
  const mc = input?.maxConcurrency;
  return {
    // 拷贝一份：调用方（initialize 的 params）可能被复用或改动，直接持有引用会被静默改写到
    allowedTools: Array.isArray(input?.allowedTools) ? input!.allowedTools.slice() : [],
    allowedDirs: Array.isArray(input?.allowedDirs) ? input!.allowedDirs.slice() : [],
    maxConcurrency:
      typeof mc === 'number' && Number.isFinite(mc) && mc > 0 ? Math.floor(mc) : 0,
  };
}

/** 一次性收敛 initialize 声明的能力 + TTL（两处缺省语义不同，见 NormalizedDeclaration）。 */
export function normalizeDeclaration(
  input?: CapabilityDeclaration | null
): NormalizedDeclaration {
  return {
    capabilities: normalizeCapabilities(input),
    approvalTtlMs:
      input?.approvalTtlMs === undefined ? null : clampApprovalTtlMs(input.approvalTtlMs),
  };
}

/** 未声明任何能力时的缺省连接级能力（供 `createConnectionRuntime` 复用，保证同源）。 */
export function defaultCapabilities(): NormalizedCapabilities {
  return normalizeCapabilities();
}

// ---------------------------------------------------------------------------
// 挂起项错误码映射
// ---------------------------------------------------------------------------

/** 三类需要用户应答的挂起项。 */
export type PendingKind = 'approval' | 'plan' | 'patch';
/** 应答的三种结果（与 SessionManager.respond* 的返回同一枚举）。 */
export type PendingOutcome = 'ok' | 'not_found' | 'expired';

export interface RpcError {
  code: number;
  message: string;
}

const PENDING_LABEL: Record<PendingKind, string> = {
  approval: '审批',
  plan: '计划',
  patch: '补丁',
};

/**
 * 把挂起项应答结果映射成 JSON-RPC 错误；`ok` 返回 `null`（调用方走成功路径）。
 *
 * 三类挂起项的失败语义完全一致（找不到 = `NotFound`，已过期 = `Expired`），此前这段三分支
 * 在 `server.ts` 里逐方法各抄一遍 —— 改一处漏两处不会有任何提示。集中到这里之后，
 * "审批/计划/补丁对同一结果给同一错误码"就成了一条可被单测钉住的约定。
 */
export function pendingRespondError(
  kind: PendingKind,
  outcome: PendingOutcome,
  id: string
): RpcError | null {
  if (outcome === 'ok') return null;
  const label = PENDING_LABEL[kind];
  if (outcome === 'expired') {
    return { code: ERROR_CODES.Expired, message: `${label}已过期: ${id}` };
  }
  return { code: ERROR_CODES.NotFound, message: `${label}不存在或已处理: ${id}` };
}

// ---------------------------------------------------------------------------
// 路径护栏（工作区 + allowedDirs 双重约束）
// ---------------------------------------------------------------------------

export type ResolvePathResult = { resolved: string } | { error: string };

/**
 * 解析目标路径并施加**双重**约束：① 必须位于工作区内；② 若声明了 `allowedDirs`，
 * 还必须位于其中之一内。
 *
 * 两层缺一不可：工作区边界挡住"跑到 /etc 去"，allowedDirs 允许客户端**主动再收窄**
 * （例如只把某个子目录交给 Agent）。少了第二层，客户端声明的收窄就是空话。
 *
 * 失败**不抛**而是返回 `{ error }`，因为调用方（`file.read` 等）要把错误直接映射成
 * `PathOutsideWorkspace` 回给客户端：抛异常会被外层 catch 统一降成 `InternalError`，
 * 错误码就不准了。
 */
export function resolvePathWithin(
  workspaceRoot: string,
  allowedDirs: string[],
  target: string
): ResolvePathResult {
  let resolved: string;
  try {
    resolved = assertPathInside(workspaceRoot, target);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  if (allowedDirs.length > 0) {
    const ok = allowedDirs.some((d) => {
      try {
        assertPathInside(d, resolved);
        return true;
      } catch {
        return false;
      }
    });
    if (!ok) {
      return { error: `路径越界：${target} 不在 allowedDirs ${allowedDirs.join(', ')} 内` };
    }
  }
  return { resolved };
}
