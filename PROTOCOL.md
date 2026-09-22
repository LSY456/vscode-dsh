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
| `initialize` | `{ workspaceRoot, apiKey?, preset?, model?, capabilities?, client: {name, version} }` | `{ daemonVersion, protocolVersion, capabilities, sessionId?, agent, agentReason? }` |
| `session.create` | `{ id?, title? }` | `{ sessionId, title? }` |
| `session.send` | `{ sessionId?, prompt, attachments? }` | `{ sessionId, accepted }` |
| `session.cancel` | `{ sessionId }` | `{ canceled }` |
| `session.resume` | `{ sessionId }` | `{ sessionId, state, pendingApproval?, pendingPatch? }` |
| `approval.respond` | `{ sessionId, approvalId, approved, note? }` | `{ ok }` |
| `file.patch.respond` | `{ sessionId, patchId, accept, content?, applyInEditor? }` | `{ ok }` |
| `file.read` | `{ path, maxBytes? }` | `{ content, truncated, size, dirty? }` |
| `workspace.syncDirty` | `{ files: [{ path, content? }] }` | `{ ok, count }` |
| `ping` | `{}` | `{ pong }` |
| `shutdown` | `{}` | `{ bye }` |

### 脏文档同步（`workspace.syncDirty`，P0-1）

daemon 是独立进程，看不到编辑器的内存文档，读取只能落磁盘；用户正在编辑未保存时**磁盘内容是过期的**。
客户端把「当前全部脏文档」推给 daemon，daemon 以**连接**为单位维护覆盖层，读取一律覆盖层优先。

- 语义是**全量快照**：每次调用代表"此刻的全部脏文档"，daemon 整体替换，不做增量合并（省去删除/重命名的对账）。
- `content` **可缺省**：超大文件只上报「该文件是脏的」。此时读取回落磁盘，但写入路径仍一律避开磁盘。
- 覆盖层**按连接隔离**：多个窗口复用同一 daemon 时互不污染（与 `capabilities` 同理）。
- 生效范围：`file.read` 返回 `dirty: true`；Agent 的 `read_file` 与 `apply_patch` 基准（diff 的 old 侧）同源。
- 落地影响：目标是脏文档时补丁**不写磁盘**——客户端改走编辑器缓冲区并回执 `applyInEditor: true`；
  未带该标记则 daemon 拒绝落盘（安全默认），`file.patch.result` 返回 `applied: false` + 原因。

### `model`（真实模型接入）

`initialize.model` 声明模型底座，daemon 端据此构建真实 Agent：

- `baseURL?: string` —— OpenAI 兼容端点 base，缺省 `https://api.deepseek.com/v1`
- `model?: string` —— 模型名，缺省 `deepseek-chat`（DeepSeek Reasoner 会流式返回 `reasoning_content`，投影为 `reasoning.delta`）
- `apiKey?: string` —— 优先于顶层 `initialize.apiKey`
- `agent?: 'mock' | 'real' | 'auto'` —— 实现选择；缺省 `auto` = 有 apiKey 则 real，否则 mock
- `idleTimeoutMs?: number` —— **模型请求空闲超时**（P0-3）：距上一个流式增量超过该时长即以
  `TimeoutError` 中断本次请求，避免模型端静默（网关挂住 / 连接半开 / 服务端排队）时会话永久
  卡在 `running`。缺省 60000；`<= 0` 关闭。会话取消（`session.cancel`）另走 `AbortController`
  立即中断在途请求，与空闲超时相互独立。

`initialize` 返回的 `agent` 字段标明本次实际生效的实现（`mock` | `real`）；扩展可据此在 UI 提示当前是否为真实模型。

**`agentReason`（可选，`agent=mock` 时的成因）** —— 用于消除"静默降级"：

- `no-api-key`：`auto` 模式但未提供 apiKey（最常见）
- `forced-mock`：显式指定 `agent=mock`（测试 / 离线演示）

为什么需要它：缺 Key 时若只是安静地回退到 mock 关键字循环，用户会把模拟回复当成真实模型的回答。
把成因显式回报给前端，UI 才能给出"演示模式"提示与配置入口。老客户端忽略该字段即可（向后兼容）。

### `capabilities`（能力分级）

`initialize.capabilities` 由客户端声明、daemon 端收紧执行：

- `allowedTools?: string[]` —— 工具白名单；**缺省或空数组 = 全部允许**，非空 = 仅白名单内可用（越权工具直接以 `tool.executed { ok:false, output:'工具被禁用' }` 结束，不发起审批）。
- `allowedDirs?: string[]` —— 目录白名单；缺省 = 仅工作区根。所有路径操作（patch / file.read / 附件读取）必须在工作区 ∩ allowedDirs 内，越界返回 `-32012`。
- `maxConcurrency?: number` —— 全局并发会话上限；0 = 不限制。
- `approvalTtlMs?: number` —— **挂起项超时**（`approval.request` / `file.patch.pending`）毫秒数；
  缺省 60s，daemon 端钳制到 `[10s, 60min]`，到点未响应按"拒绝"解除挂起。daemon 会把生效值
  盖戳到挂起事件上（`expiresAt`），客户端据此显示倒计时。

> **路径护栏为 canonical 判定**：daemon 以 `realpath` 解析后的规范路径做包含判断，符号链接 /
> 目录联结（Windows junction）指向工作区外、`..` 逃逸、NUL 与 Windows 备用数据流（ADS）一律返回 `-32012`。

### `attachments`（流程二：主动上下文捕获）

VSCode 侧自动打包的结构化附件，`kind` 取值：

- `file`：活动文件全文（`uri/path/language/name/content`）；**大文件以 `contentOmitted: true` 省略内容**，daemon 按需 `file.read`（不再硬截断）。
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
| `file.patch.pending` | **挂起点**：文件修改待审查（path/oldContent/newContent/description/expiresAt） |
| `file.patch.result` | 补丁决策结果（accepted/applied/error） |
| `trajectory.record` | 迹线步骤（step/kind/detail/ts） |
| `session.ended` | 会话结束（reason: completed/canceled/error） |
| `error` | 协议/运行错误（code 取值见错误码表） |

## 5. 会话状态机、审批/补丁挂起-恢复、续跑与心跳

### 状态机

每个会话独立维护状态：`idle -> running -> (pending_approval | pending_patch) -> running -> idle`

```
session.send ──> (流式事件...) ──> approval.request ──挂起──> approval.respond ──> tool.executed ──> session.ended
                                └─> file.patch.pending ──挂起──> file.patch.respond ──> file.patch.result ─┘
```

- **并发**：状态为 `idle` 才允许 `session.send`（同一会话返回 `-32009 Busy`）；**不同会话可并行**（多会话并发）。
- **挂起强校验**：`approval.respond` / `file.patch.respond` 校验 id 归属；不存在的 id 返回 `-32013 NotFound`；
  超过 `expiresAt`（默认 60s）返回 `-32010 Expired`，且到点自动按"拒绝"解析以解除挂起。
- **取消**：`session.cancel` 置 canceled 标记并将挂起项按拒绝解除，Agent 收尾发出 `session.ended(reason=canceled)`。

### 断线续跑（session.resume）

- daemon 为每个会话维护**事件环形缓冲**（默认 2000 条）：断线期间事件照常入缓冲（不丢失）。
- 重连后客户端以原 `sessionId` 调用 `session.resume`：daemon **重放缓冲事件**并返回当前
  `state` 与挂起快照（`pendingApproval` / `pendingPatch`，含 `expiresAt`），UI 据此恢复审批/补丁卡片。
- daemon 进程重启后会话丢失，`resume` 返回 `-32013 NotFound`，客户端回退 `session.create` 新建会话。

### 心跳

客户端每 15s `ping`，连续 3 次无响应判定链路死亡并强制重连（重连后走 resume 恢复）。

## 6. 迹线（Trajectory）数据映射

对应方案中"迹线数据映射"要点：daemon 内部轨迹（模型调用、工具调度、审批、补丁、状态变化）
以 **`trajectory.record` 事件流**投影到 VSCode 侧，每条记录包含：

- `step`：会话内单调递增的步骤号（用于 UI 时间线与回放）
- `kind`：`reasoning | message | tool | patch | approval | system`
- `detail`：人类可读的步骤摘要
- `ts`：epoch 毫秒时间戳

VSCode 侧将轨迹渲染为可折叠的"执行迹线"面板，并可据此实现审计、回放与失败定位；
真实 daemon 的持久化轨迹会追加写 `.dsh/trajectory/<sessionId>.jsonl`（命中大小上限自动归档）。

## 6b. Agent 工具约定（真实 daemon 实现参考）

`session.send` 之后，daemon 内部驱动模型循环，模型通过 **fenced toolcall 块**发起工具调用：

````text
```toolcall
{"tool":"read_file","input":{"path":"..."}}
```
````

支持的工具与约束（真实 daemon 与参考实现保持一致）：

| tool | input | 行为 |
| --- | --- | --- |
| `read_file` / `list_dir` | `{ path }` | 只读，路径护栏内；越界 `tool.executed { ok:false }` |
| `write_file` | `{ path, content }` | 全量覆盖；先 `file.patch.pending` 走 Diff 审查，接受后写盘 |
| `apply_patch` | `{ path, search, replace }` | 字符串替换；同样走补丁审查 |
| `bash_execute` | `{ command }` | 高危：先命令策略门控，再 `approval.request`，批准后执行 |

所有工具受 `capabilities.allowedTools` 约束（禁用即 `tool.executed { ok:false }`，不挂起）。

## 7. 错误码

| code | 名称 | 含义 |
| --- | --- | --- |
| `-32700` | ParseError | JSON 解析失败 |
| `-32600` | InvalidRequest | 非法的 JSON-RPC 消息 |
| `-32601` | MethodNotFound | 方法不存在 |
| `-32602` | InvalidParams | 参数错误 |
| `-32603` | InternalError | 服务端内部错误 |
| `-32009` | Busy | 同一会话正在运行中 / 并发达上限 |
| `-32010` | Expired | 审批或补丁已过期（超过 expiresAt） |
| `-32012` | PathOutsideWorkspace | 目标路径越界（工作区 / allowedDirs） |
| `-32013` | NotFound | 会话 / 审批 / 补丁不存在 |

## 8. 扩展建议

- 客户端通知（无 `id` 的请求）为协议预留位，可用于上报编辑器事件（如文件切换）以实现被动上下文注入。
- 参考 daemon 已内置两种 Agent 实现：`mock`（关键字驱动，演示/测试）与 `real`（通过 `OpenAICompatibleModel`
  调用真实模型 + 真实只读/写入/命令工具）。

## 9. 第二实现：可插拔不是承诺，是可验证事实

"前端可换（VSCode / JetBrains / CLI）、后端可换"如果只有本仓库的 Node daemon 一个实现，
就无从判断协议里有没有夹带实现细节。因此仓库里提供了一个**换语言的独立实现**：

```
examples/python-daemon/dsh_daemon.py     # Python 3 + 仅标准库（无 pip 依赖）
```

它刻意最小化：只实现 `initialize` / `session.create` / `session.send` / `session.cancel` /
`ping` / `shutdown`，外加一个 `read_file` 工具（走通用的 `tool.started` / `tool.executed` 时序），
**不实现**真实模型、补丁审查、审批挂起、断线续跑、轨迹持久化——这些都不影响"协议可插拔"的证明。
连 WebSocket 服务端都是手写的 RFC 6455 子集（文本帧 + 掩码 + ping/pong/close），
所以它对 Node 生态零依赖。

```
npm run smoke:protocol           # 拉起该 daemon 并按协议走完一轮；缺 Python 3 时优雅跳过
npm run smoke:protocol -- --require   # 缺 Python 3 判失败（CI 用，禁止静默跳过）
```

该脚本同时是本协议的一份**可执行规格**：端口上报约定、握手鉴权（错 token / 带 `Origin` 均拒绝）、
事件时序、路径护栏、错误码，全部有断言。任何新实现照着它跑通即为兼容。
