# dsh Agent Daemon 协议规范（Protocol v1.0）

VSCode 扩展与 dsh Agent Daemon 之间通过 **JSON-RPC 2.0 over WebSocket** 通信。
本文档是两端共享的契约（实现见 `shared/protocol.ts`，真实 daemon 须兼容）。

## 1. 传输与安全

| 项 | 约定 |
| --- | --- |
| 传输 | WebSocket，文本帧，UTF-8 JSON，**每帧一条消息** |
| 监听 | 仅 `127.0.0.1`，默认随机端口 |
| 握手 | 打开连接时携带 `Authorization: Bearer <token>`，否则拒绝（close 握手失败） |
| Origin 校验 | 携带浏览器 `Origin` 头的连接一律拒绝（防 CSWSH） |
| Token 生成 | 扩展侧 `crypto.randomBytes(24).hex`，经环境变量 `DSH_DAEMON_TOKEN` 传给 daemon，不写盘 |
| 端口发现 | daemon 就绪后向 stdout 打印 `DSH_DAEMON_PORT=<port>`，并可写 `--port-file` |

## 2. 消息外壳

请求（带 `id`）：

```json
{ "jsonrpc": "2.0", "id": 1, "method": "session.send", "params": { "sessionId": "sess_xxx", "prompt": "…" } }
```

响应：

```json
{ "jsonrpc": "2.0", "id": 1, "result": { "accepted": true } }
{ "jsonrpc": "2.0", "id": 1, "error": { "code": -32009, "message": "session 正在运行中" } }
```

事件通知（无 `id`，服务端 -> 客户端）：

```json
{ "jsonrpc": "2.0", "method": "reasoning.delta", "params": { "sessionId": "sess_xxx", "delta": "…" } }
```

## 3. 方法（客户端 -> 服务端）

| method | params | result |
| --- | --- | --- |
| `initialize` | `{ workspaceRoot, apiKey?, preset?, client: {name, version} }` | `{ daemonVersion, protocolVersion, capabilities }` |
| `session.create` | `{ id?, title? }` | `{ sessionId, title? }` |
| `session.send` | `{ sessionId?, prompt, attachments? }` | `{ sessionId, accepted }` |
| `session.cancel` | `{ sessionId }` | `{ canceled }` |
| `approval.respond` | `{ sessionId, approvalId, approved, note? }` | `{ ok }` |
| `file.patch.respond` | `{ sessionId, patchId, accept }` | `{ ok }` |
| `ping` | `{}` | `{ pong }` |
| `shutdown` | `{}` | `{ bye }` |

### `attachments`（流程二：主动上下文捕获）

VSCode 侧自动打包的结构化附件，`kind` 取值：

- `file`：活动文件全文（`uri/path/language/name/content`）
- `selection`：高亮选区（`content/range.startLine/endLine`）
- `diagnostics`：`vscode.languages.getDiagnostics` 映射（`severity/message/range/source`）
- `gitStatus`：`git status --short --branch` 输出
- `text`：任意纯文本

## 4. 事件（服务端 -> 客户端）

| event | 说明 |
| --- | --- |
| `session.started` | 会话开始（携带 title） |
| `reasoning.delta` | 推理思考流增量 |
| `message.delta` | 文本回答流增量 |
| `message.done` | 回答流结束 |
| `tool.started` / `tool.executed` | 工具执行开始/结束（含 ok/output/durationMs） |
| `approval.request` | **挂起点**：高危工具待人工审批（tool/input/risk/reason/expiresAt） |
| `file.patch.pending` | **挂起点**：文件修改待审查（path/oldContent/newContent/description） |
| `file.patch.result` | 补丁决策结果（accepted/applied/error） |
| `trajectory.record` | 迹线步骤（step/kind/detail/ts） |
| `session.ended` | 会话结束（reason: completed/canceled/error） |
| `error` | 协议/运行错误 |

## 5. 审批与补丁的挂起-恢复状态机

```
session.send ──> (流式事件...) ──> approval.request ──挂起──> approval.respond ──> tool.executed ──> session.ended
                                └─> file.patch.pending ──挂起──> file.patch.respond ──> file.patch.result ─┘
```

- 挂起期间 daemon 暂停该会话的 Agent 循环；`approval.respond` / `file.patch.respond` 恢复执行。
- 60s 无响应按拒绝处理；`session.cancel` 会把挂起的审批/补丁按拒绝解除并结束会话。
- 同一连接同一时刻只允许一个运行中的会话（并发 `session.send` 返回 `-32009`）。

## 6. 迹线（Trajectory）数据映射

对应方案中"迹线数据映射"要点：daemon 内部轨迹（模型调用、工具调度、审批、补丁、状态变化）
以 **`trajectory.record` 事件流**投影到 VSCode 侧，每条记录包含：

- `step`：会话内单调递增的步骤号（用于 UI 时间线与回放）
- `kind`：`reasoning | message | tool | patch | approval | system`
- `detail`：人类可读的步骤摘要
- `ts`：epoch 毫秒时间戳

VSCode 侧将轨迹渲染为可折叠的"执行迹线"面板，并可据此实现审计、回放与失败定位；
真实 daemon 的持久化轨迹存储（如 JSONL/DB）与此事件流一一对应，字段可扩展但不得删除现有语义。

## 7. 扩展建议

- 客户端通知（无 `id` 的请求）为协议预留位，可用于上报编辑器事件（如文件切换）以实现被动上下文注入。
- 如需多会话并发，可在 `session.send` 增加 `concurrency` 能力位并放宽 `-32009` 限制。
- 真实 daemon（Cordis 动态插件版）须实现同一方法/事件名与上述挂起-恢复语义。
