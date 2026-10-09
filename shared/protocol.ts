/**
 * dsh Agent Daemon 协议契约（JSON-RPC 2.0 over WebSocket）。
 *
 * 该文件同时被 Extension Host（wsClient / daemonManager）与参考 daemon
 * （src/daemon/*）引用，保证两端消息结构完全一致。真实 daemon（例如
 * 以 Cordis 动态插件实现的版本）也必须实现同一套方法名与事件名。
 *
 * 传输约定：
 *  - 消息为 UTF-8 JSON，每条消息一行（\n 分隔），便于逐帧解析。
 *  - 请求带 id（number），响应 id 与之对应；无 id 的消息为通知。
 *  - 仅监听 127.0.0.1；WebSocket 打开握手必须携带 `Authorization: Bearer <token>`。
 */

// ---------------------------------------------------------------------------
// JSON-RPC 外壳
// ---------------------------------------------------------------------------

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  /** JSON-RPC 规范允许解析失败等场景使用 null id */
  id: number | string | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

// 协议方法名常量（客户端 -> 服务端）
export const METHODS = {
  Initialize: 'initialize',
  SessionCreate: 'session.create',
  SessionSend: 'session.send',
  SessionCancel: 'session.cancel',
  SessionResume: 'session.resume',
  SessionRollback: 'session.rollback',
  ApprovalRespond: 'approval.respond',
  FilePatchRespond: 'file.patch.respond',
  FileRead: 'file.read',
  WorkspaceSyncDirty: 'workspace.syncDirty',
  TrustList: 'trust.list',
  TrustClear: 'trust.clear',
  TrajectoryList: 'trajectory.list',
  Ping: 'ping',
  Shutdown: 'shutdown',
} as const;

// 协议错误码常量
export const ERROR_CODES = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  /** 同一会话正在运行中（或并发达到上限） */
  Busy: -32009,
  /** 审批/补丁已过期（超过 expiresAt） */
  Expired: -32010,
  /** 目标路径不在工作区（或 allowedDirs）内 */
  PathOutsideWorkspace: -32012,
  /** 会话 / 审批 / 补丁不存在 */
  NotFound: -32013,
} as const;

// 协议事件名常量（服务端 -> 客户端通知）
export const EVENTS = {
  SessionStarted: 'session.started',
  ReasoningDelta: 'reasoning.delta',
  MessageDelta: 'message.delta',
  MessageDone: 'message.done',
  ToolStarted: 'tool.started',
  ToolExecuted: 'tool.executed',
  ApprovalRequest: 'approval.request',
  FilePatchPending: 'file.patch.pending',
  FilePatchResult: 'file.patch.result',
  Trajectory: 'trajectory.record',
  SessionEnded: 'session.ended',
  Error: 'error',
} as const;

// ---------------------------------------------------------------------------
// 握手（流程一：进程生命周期与建连握手）
// ---------------------------------------------------------------------------

/** 模型调用配置（P3：真实 daemon） */
/**
 * Agent 循环预算的缺省值。放在协议里由两侧共用 ——
 * 这两个值此前是 daemon 侧的**死配置**：`RealAgentConfig` 有字段、`realAgent` 会读，
 * 但扩展从不下发、`package.json` 也没有对应项，用户根本改不到（而文档却写着"可配"）。
 */
export const DEFAULT_MAX_TOOL_ROUNDS = 8;
export const DEFAULT_MAX_CONTEXT_TOKENS = 48 * 1024;

/**
 * 采样温度缺省值。取自 daemon 模型层原先的硬编码值（0.2）——
 * 这是"把既有行为暴露成可配项"，**不是**调整缺省行为的地方。
 */
export const DEFAULT_TEMPERATURE = 0.2;

/**
 * 单次输出上限（max_tokens）的回落值。
 *
 * 语义按 provider 分岔：OpenAI 兼容端点**不发送**该字段（上限由服务端决定），
 * 只有 Anthropic 的 /v1/messages 把它列为必填，未配置时才回落到这里。
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

export interface ModelConfig {
  /** API 端点 base，如 https://api.deepseek.com/v1 */
  baseURL?: string;
  /** 模型名，如 deepseek-flash */
  model?: string;
  /** 模型 API Key（优先于 InitializeParams.apiKey） */
  apiKey?: string;
  /** 实现选择：real（真实模型）| mock（内置模拟）| auto（缺省，有 key 则 real） */
  agent?: 'mock' | 'real' | 'auto';
  /** 模型 provider（P3.5+ 多点位）：openai（OpenAI 兼容，含 DeepSeek/通义等）| anthropic | auto（缺省=openai） */
  provider?: 'openai' | 'anthropic' | 'auto';
  /**
   * 模型请求空闲超时（ms，P0-3）：距上一个流式增量超过该时长即中断本次请求，
   * 避免模型端静默时会话永久挂起。缺省 60000；<= 0 关闭。
   */
  idleTimeoutMs?: number;
  /**
   * 工具调用轮数上限（防止模型反复试探耗尽预算）。
   * 缺省 `DEFAULT_MAX_TOOL_ROUNDS`；跑满后 Agent 会收束成一次不带工具定义的最终回答。
   */
  maxToolRounds?: number;
  /**
   * 上下文 token 预算：发送前按此估算并裁剪历史（超预算时整轮丢弃最旧的工具轮）。
   * 缺省 `DEFAULT_MAX_CONTEXT_TOKENS`。
   */
  maxContextTokens?: number;
  /**
   * 采样温度（0–2）：越低越确定、越高越发散。未配置时沿用 `DEFAULT_TEMPERATURE`。
   * 注意 Anthropic 的合法区间是 0–1 —— 越界值在模型层钳制，不原样发出
   * （原样发出只会换来一个与配置无关的 400）。
   */
  temperature?: number;
  /**
   * 单次输出上限（max_tokens）。未配置 / `<= 0` = **不发送该字段**（OpenAI 兼容端点由服务端
   * 决定上限）；Anthropic 必填，故回落 `DEFAULT_MAX_OUTPUT_TOKENS`。
   */
  maxTokens?: number;
}

export interface InitializeParams {
  /** VSCode 当前打开的工作区根路径 */
  workspaceRoot: string;
  /** 模型 API Key（daemon 端可按需忽略） */
  apiKey?: string;
  /** Agent 预设名 */
  preset?: string;
  /** 模型调用配置（真实 daemon 用） */
  model?: ModelConfig;
  /** 客户端声明的能力诉求（daemon 端按需收紧） */
  capabilities?: {
    /** 允许使用的工具白名单；缺省/空数组 = 全部允许 */
    allowedTools?: string[];
    /** 允许访问的目录白名单；缺省 = 仅工作区根 */
    allowedDirs?: string[];
    /** 全局并发会话上限；0 = 不限制 */
    maxConcurrency?: number;
    /**
     * 挂起项（approval.request / file.patch.pending）超时毫秒数；
     * 缺省 60s，daemon 端钳制到 [10s, 60min]。到点未响应按拒绝处理。
     */
    approvalTtlMs?: number;
  };
  client: {
    name: string;
    version: string;
  };
}

export interface InitializeResult {
  daemonVersion: string;
  /** 每次构建生成的随机指纹（陈旧 daemon 识别用，可选向后兼容） */
  buildId?: string;
  protocolVersion: '1.0';
  capabilities: {
    streaming: boolean;
    approvals: boolean;
    filePatches: boolean;
    sessions: boolean;
    trajectory: boolean;
    resume: boolean;
    fileRead: boolean;
    /** P2-6 会话级回滚（可选，向后兼容）：daemon 会为改动留影子快照并支持还原 */
    rollback?: boolean;
  };
  /** daemon 为本次连接分配/复用的默认会话 id */
  sessionId?: string;
  /** 本次生效的 Agent 实现（real = 真实模型 / mock = 内置模拟） */
  agent?: 'mock' | 'real';
  /**
   * `agent` 为 mock 时的成因，供 UI **显式提示**（可选，向后兼容）。
   *
   * 背景：旧行为在未配置模型 Key 时静默回退 mock 关键字循环，用户以为在跑真模型。
   * 现在 daemon 把成因一并回报，UI 据此渲染"演示模式"横幅并给出配置入口。
   *  - `no-api-key`：auto 模式且未提供 apiKey（最常见）
   *  - `forced-mock`：显式指定 `agent=mock`（测试 / 离线演示）
   */
  agentReason?: 'no-api-key' | 'forced-mock';
}

// ---------------------------------------------------------------------------
// Session / 上下文（流程二：主动上下文捕获与 Prompt 发起）
// ---------------------------------------------------------------------------

export interface Diagnostic {
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  range: {
    startLine: number;
    startCol: number;
    endLine: number;
    endCol: number;
  };
  source?: string;
}

/** VSCode 捕获后打包的结构化附件 */
export interface Attachment {
  kind: 'file' | 'selection' | 'diagnostics' | 'gitStatus' | 'text';
  /** file/selection 对应的文件 URI（file:// 或 vscode 自定义 scheme） */
  uri?: string;
  /** 文件绝对路径 */
  path?: string;
  /** 文件语言 id，如 typescript */
  language?: string;
  /** 显示名称（如文件名） */
  name?: string;
  /** 文件/选区内容；大文件可省略并以 contentOmitted 标记，daemon 按需 file.read */
  content?: string;
  /** 内容因过大被省略，daemon 可通过 file.read 按需读取 */
  contentOmitted?: boolean;
  /** 选区行区间（1-based，含） */
  range?: {
    startLine: number;
    endLine: number;
  };
  /** diagnostics 附件 */
  diagnostics?: Diagnostic[];
  /** gitStatus 附件 */
  gitStatus?: string;
  /** 纯文本附件 */
  text?: string;
}

export interface SessionCreateParams {
  id?: string;
  title?: string;
}

export interface SessionCreateResult {
  sessionId: string;
  title?: string;
}

export interface SessionSendParams {
  sessionId?: string;
  prompt: string;
  attachments?: Attachment[];
}

export interface SessionSendResult {
  sessionId: string;
  accepted: boolean;
}

export interface SessionCancelParams {
  sessionId: string;
}

/** 会话运行状态（断线续跑 / UI 状态同步用） */
export type SessionState = 'idle' | 'running' | 'pending_approval' | 'pending_patch';

export interface SessionResumeParams {
  sessionId: string;
}

export interface SessionResumeResult {
  sessionId: string;
  state: SessionState;
  /** 若处于 pending_approval，携带待审批快照 */
  pendingApproval?: {
    approvalId: string;
    expiresAt: number;
    tool: string;
    input: Record<string, unknown>;
    risk: 'low' | 'medium' | 'high';
    reason: string;
  };
  /** 若处于 pending_patch，携带待审查补丁快照 */
  pendingPatch?: {
    patchId: string;
    expiresAt: number;
    path: string;
    oldContent?: string;
    newContent: string;
    description?: string;
  };
}

// ---------------------------------------------------------------------------
// 会话级事务回滚（P2-6）
// ---------------------------------------------------------------------------

/**
 * 会话级回滚：把**本次会话**改动过的文件还原到会话开始前。
 *
 * 与 Diff 审批是互补的两道门：审批在改动前拦（事前），回滚在改动后兜（事后）。
 * daemon 侧在「每个文件第一次被写入之前」留一份影子快照（首写优先），本方法据此还原。
 */
export interface SessionRollbackParams {
  sessionId?: string;
}

/**
 * 回滚结果。各类**分列而不是合并成一句失败**——
 * 「跳过了什么、为什么跳过」与「还原成功」对用户的下一步动作完全不同：
 * 脏文档跳过要用户先保存/放弃改动，不可还原要用户手工处理，失败要用户去查日志。
 */
export interface SessionRollbackResult {
  /** 本次会话记录到的改动文件总数 */
  total: number;
  /** 已还原为会话开始前的内容 */
  restored: string[];
  /** 本次会话新建、回滚时已删除的文件 */
  deleted: string[];
  /** 因编辑器有未保存改动而跳过（绝不覆盖用户正在编辑的内容） */
  skippedDirty: string[];
  /**
   * 因文件在本次会话之后被别的通路改过（用户手工编辑并保存 / 外部工具 / 另一会话）而跳过。
   * 与 `skippedDirty` 分开列：前者要先保存，后者要先看这些改动是什么、再决定是否仍然回滚。
   */
  changedAfter: { path: string; reason: string }[];
  /** 记录时就未能留存内容（文件过大等），无法回滚 */
  unrestorable: { path: string; reason: string }[];
  /** 还原过程中写盘 / 删除失败 */
  failed: { path: string; error: string }[];
  /** 因快照条目上限而完全未被记录的改动数（> 0 时本次回滚可能不完整） */
  unrecorded: number;
}

export interface FileReadParams {
  /** 待读取文件的绝对路径（须位于工作区 / allowedDirs 内） */
  path: string;
  maxBytes?: number;
}

export interface FileReadResult {
  content: string;
  truncated: boolean;
  size: number;
  /**
   * P0-1 脏文档一致性：内容来自编辑器**未保存**的缓冲区（而非磁盘）。
   * 供 UI 标注「未保存」，避免用户误以为读到的是落盘版本。
   */
  dirty?: boolean;
}

/**
 * 脏文档同步（P0-1，客户端 -> 服务端通知）。
 *
 * daemon 是独立进程，看不到 VSCode 的内存文档，只能读磁盘——而用户正在编辑的文件
 * 磁盘内容往往是**过期**的。若不校正，Agent 会基于旧内容推理并产出补丁，覆盖用户
 * 尚未保存的改动。故客户端把「当前全部脏文档」的缓冲区内容推给 daemon，daemon 侧
 * 以连接为单位维护覆盖层（overlay），读取时**优先取覆盖层**。
 *
 * 语义为**全量快照**：每次调用都代表"此刻工作区的全部脏文档"，daemon 整体替换，
 * 不做增量合并（省去删除/重命名的对账，避免残留幽灵内容）。
 */
export interface DirtyFileEntry {
  /** 绝对路径（VSCode 的 uri.fsPath） */
  path: string;
  /**
   * 编辑器缓冲区当前全文（含未保存改动）。
   * **可缺省**：超大文件不值得每次按键都把全文推过 WebSocket，此时只上报「该文件是脏的」——
   * daemon 侧读取回落磁盘，但**写入路径一律避开磁盘**（转交编辑器），照样不会覆盖未保存改动。
   */
  content?: string;
}

export interface WorkspaceSyncDirtyParams {
  /** 当前全部脏文档；空数组表示"没有脏文档"，覆盖层应清空 */
  files: DirtyFileEntry[];
}

// ---------------------------------------------------------------------------
// 工具审批（流程三：双向流式推理与工具审批循环）
// ---------------------------------------------------------------------------

export interface ApprovalRespondParams {
  sessionId: string;
  approvalId: string;
  approved: boolean;
  note?: string;
  /** B1 信任记忆：true 且 approved 时，daemon 把该命令纳入免审批白名单 */
  trust?: boolean;
}

// ---------------------------------------------------------------------------
// 信任记忆（B1：免审批白名单）
// ---------------------------------------------------------------------------

export type TrustRuleKind = 'exact' | 'prefix';

export interface TrustRuleData {
  id: string;
  kind: TrustRuleKind;
  pattern: string;
  createdAt: number;
}

export interface TrustListResult {
  rules: TrustRuleData[];
}

// ---------------------------------------------------------------------------
// 文件补丁（流程四：代码修改与 Native Diff 预览）
// ---------------------------------------------------------------------------

export interface FilePatchRespondParams {
  sessionId: string;
  patchId: string;
  accept: boolean;
  /** P2 编辑后应用：accept 时携带用户编辑后的完整内容（缺省则用 agent 原始 newContent） */
  content?: string;
  /**
   * P0-1 脏文档一致性：**客户端已把改动应用到编辑器缓冲区**，daemon 不要再写磁盘。
   *
   * 目标文件在编辑器里有未保存改动时，写盘会与缓冲区「分叉」：用户下一次 Ctrl+S 就会
   * 用旧缓冲区覆盖掉 Agent 的落盘结果（或反之）。因此脏文档一律改走编辑器
   * WorkspaceEdit——缓冲区与磁盘重新对齐，且用户是「先审后又改」，改动仍保持未保存态
   * 可自行复核。客户端在应用成功后才带此标记回调，daemon 侧以「已交由编辑器」收尾。
   */
  applyInEditor?: boolean;
}

// ---------------------------------------------------------------------------
// 服务端事件负载
// ---------------------------------------------------------------------------

export interface EventSessionStarted {
  sessionId: string;
  title?: string;
}

export interface EventReasoningDelta {
  sessionId: string;
  delta: string;
}

export interface EventMessageDelta {
  sessionId: string;
  delta: string;
}

export interface EventMessageDone {
  sessionId: string;
  messageId?: string;
}

export interface EventToolStarted {
  sessionId: string;
  tool: string;
  input: Record<string, unknown>;
}

export interface EventToolExecuted {
  sessionId: string;
  tool: string;
  ok: boolean;
  output?: string;
  durationMs?: number;
  /** B1 信任记忆：true 表示命中免审批白名单放行 */
  trusted?: boolean;
}

export interface EventApprovalRequest {
  sessionId: string;
  approvalId: string;
  tool: string;
  input: Record<string, unknown>;
  risk: 'low' | 'medium' | 'high';
  reason: string;
  /** 过期时间（epoch ms），过期后按拒绝处理 */
  expiresAt?: number;
}

export interface EventFilePatchPending {
  sessionId: string;
  patchId: string;
  /** 被修改文件的绝对路径 */
  path: string;
  /** 修改前内容快照（文件不存在时为 undefined） */
  oldContent?: string;
  /** 修改后完整内容 */
  newContent: string;
  description?: string;
  /** 过期时间（epoch ms），过期后按拒绝处理（daemon 盖戳，UI 用于显示倒计时） */
  expiresAt?: number;
}

export interface EventFilePatchResult {
  sessionId: string;
  patchId: string;
  accepted: boolean;
  applied: boolean;
  error?: string;
  /**
   * P0-1：改动已由客户端应用到编辑器缓冲区（目标文件存在未保存改动，故未写磁盘）。
   * `applied` 保持 false（daemon 未落盘），UI 应提示「已应用到编辑器，保存后生效」。
   */
  appliedInEditor?: boolean;
}

/**
 * 迹线（Trajectory）数据映射：daemon 内部的轨迹记录以统一事件流
 * 投影到 VSCode 侧，UI 可据此渲染"步骤时间线"，并用于回放与审计。
 */
export interface EventTrajectory {
  sessionId: string;
  step: number;
  kind: 'reasoning' | 'message' | 'tool' | 'patch' | 'approval' | 'system';
  detail: string;
  ts: number;
}

// ---------------------------------------------------------------------------
// 轨迹查询（C3：trajectory.list —— 以协议方法回放持久化轨迹，替代直接读 JSONL 文件）
// ---------------------------------------------------------------------------

export interface TrajectoryListParams {
  sessionId: string;
}

export interface TrajectoryListResult {
  records: EventTrajectory[];
}

export interface EventSessionEnded {
  sessionId: string;
  reason?: 'completed' | 'canceled' | 'error';
  error?: string;
}

export interface EventError {
  sessionId?: string;
  code?: number;
  message: string;
}

// ---------------------------------------------------------------------------
// 类型守卫与工具
// ---------------------------------------------------------------------------

export function isJsonRpcResponse(msg: unknown): msg is JsonRpcResponse {
  const m = msg as { jsonrpc?: unknown; id?: unknown; result?: unknown; error?: unknown };
  if (!m || m.jsonrpc !== '2.0' || m.id === undefined) return false;
  // 响应必须恰好携带 result 或 error 之一
  return ('result' in m) !== ('error' in m);
}

export function isJsonRpcNotification(msg: unknown): msg is JsonRpcNotification {
  const m = msg as { jsonrpc?: unknown; id?: unknown; method?: unknown };
  return !!m && m.jsonrpc === '2.0' && m.id === undefined && typeof m.method === 'string';
}

export function isJsonRpcRequest(msg: unknown): msg is JsonRpcRequest {
  const m = msg as { jsonrpc?: unknown; id?: unknown; method?: unknown };
  return !!m && m.jsonrpc === '2.0' && m.id !== undefined && typeof m.method === 'string';
}
