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
  ApprovalRespond: 'approval.respond',
  FilePatchRespond: 'file.patch.respond',
  Ping: 'ping',
  Shutdown: 'shutdown',
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

export interface InitializeParams {
  /** VSCode 当前打开的工作区根路径 */
  workspaceRoot: string;
  /** 模型 API Key（daemon 端可按需忽略） */
  apiKey?: string;
  /** Agent 预设名 */
  preset?: string;
  client: {
    name: string;
    version: string;
  };
}

export interface InitializeResult {
  daemonVersion: string;
  protocolVersion: '1.0';
  capabilities: {
    streaming: boolean;
    approvals: boolean;
    filePatches: boolean;
    sessions: boolean;
    trajectory: boolean;
  };
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
  /** 文件/选区内容 */
  content?: string;
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

// ---------------------------------------------------------------------------
// 工具审批（流程三：双向流式推理与工具审批循环）
// ---------------------------------------------------------------------------

export interface ApprovalRespondParams {
  sessionId: string;
  approvalId: string;
  approved: boolean;
  note?: string;
}

// ---------------------------------------------------------------------------
// 文件补丁（流程四：代码修改与 Native Diff 预览）
// ---------------------------------------------------------------------------

export interface FilePatchRespondParams {
  sessionId: string;
  patchId: string;
  accept: boolean;
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
}

export interface EventFilePatchResult {
  sessionId: string;
  patchId: string;
  accepted: boolean;
  applied: boolean;
  error?: string;
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
