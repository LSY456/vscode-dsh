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
| `session.send` | `{ sessionId?, prompt, attachments?, planMode? }` | `{ sessionId, accepted }` |
| `session.cancel` | `{ sessionId }` | `{ canceled }` |
| `session.resume` | `{ sessionId }` | `{ sessionId, state, pendingApproval?, pendingPatch?, pendingPlan? }` |
| `session.rollback` | `{ sessionId? }` | `{ total, restored, deleted, skippedDirty, changedAfter, unrestorable, failed, unrecorded }` |
| `approval.respond` | `{ sessionId, approvalId, approved, note? }` | `{ ok }` |
| `plan.respond` | `{ sessionId, planId, approved, note? }` | `{ ok }` |
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

### 会话级回滚（`session.rollback`，P2-6）

与 Diff 审批互补：**审批是事前拦截，回滚是事后兜底**。

- daemon 在**每个文件第一次被写入之前**把它的当前内容存成影子快照（`.dsh/snapshots/<sessionId>/`），
  同一文件的后续改动**不再覆盖**——回滚语义是「回到本次会话开始前」，不是「回到上一次修改前」。
- 落地通路的两条（写盘 / 交由编辑器 `applyInEditor`）都会记录；被拒绝、乐观锁冲突等**没有真正改动**的
  分支一律不记录。
- 结果**分列**（不是一句"成功/失败"）：`restored`（还原为改动前）/ `deleted`（本次新建，已删除）/
  `skippedDirty`（目标此刻在编辑器里有未保存改动，**跳过不覆盖**）/ `changedAfter`（文件在本次会话之后
  又被改过，例如用户手工编辑并**保存**，**跳过不覆盖**）/ `unrestorable`（改动前内容未能留存，
  如文件过大）/ `failed`（写盘或删除失败）/ `unrecorded`（快照条目达上限而未纳入回滚的改动数）。
- **还原前比对写入指纹**：仅凭"编辑器里没保存"挡不住"改完又保存"——那种文件不脏，回滚会把用户改动
  连同 Agent 的一起退回，而报告还显示"全部成功"。故 daemon 在每次写入后记下**写入内容**的 sha256
  （首写优先只约束"改动前内容"，指纹反过来取**最后一次**写入），还原前读磁盘比对，不一致即归入
  `changedAfter`。**观测不到写入内容的旧索引/老 daemon 退化为仅按脏文档判定**，不让回滚整体失效。
- 三条门禁：**运行中的会话拒绝回滚**（返回 `-32009`，避免与写入并发）；**还原前对每条路径重做
  canonical 越界校验**；**内容引用（`blob`）同样按白名单形状校验** —— 它与 `path` 同源于
  `index.json` 这个本机可写文件，只校验 `path` 等于留了半扇门。
- `initialize` 的 `capabilities.rollback` 声明该实现支持会话级回滚（可选，老客户端忽略即可）；
- `initialize` 返回的 `capabilities.plan` 声明该实现支持计划模式（可选，同上）。
- 快照**只增不改**，清理交给用户（`.dsh/` 是旁路目录，可随时删）。

### 计划模式（Plan，P2-7）

`session.send` 带 `planMode: true` 时，本轮**先只调研、只出方案**，方案经用户批准后才进入执行阶段。
它复用审批那套"挂起—恢复"基础设施，因此断线续跑、超时、取消的语义与审批完全一致。

- **调研阶段只读**：可用工具在**工具清单这一层**收窄为 `read_file` / `list_dir` / `grep` / `glob`
  —— 靠提示词说"别改文件"不可靠，模型看不到写入工具就发不出写入调用。
- **调研轮次独立预算**（`DEFAULT_PLAN_MAX_ROUNDS` = 4）**不占用** `maxToolRounds`：共用一份的话，
  计划阶段读得越多、批准后可用轮次越少，用户看到的是"批准完直接没轮次了"。
- **收束方式与主循环同源**：调研预算用尽仍在调工具时，不传 `tools` 再问一次，逼模型把已知信息写成计划，
  而不是把"没产出"甩给用户。
- **挂起点**：调研完成 → `plan.request { sessionId, planId, plan, expiresAt }`，会话转入 `pending_plan`；
  用户以 `plan.respond { sessionId, planId, approved, note? }` 批准或拒绝。
  不存在的 `planId` → `-32013 NotFound`；超过 `expiresAt` → `-32010 Expired`（到点按"拒绝"解析）。
- **批准**：daemon 把「已批准的计划」与可选备注一起回注 `messages`，并**保留调研阶段的工具结果**
  （那才是计划的地基；执行阶段直接复用，也让"计划里写的路径"与"执行时读到的内容"是同一份）。
  随后恢复完整工具集，进入正常执行循环。
- **拒绝**：以 `session.ended { reason: 'canceled' }` 收尾并明说「没有改动任何文件」。
  **不能报 `completed`** —— 用户拒绝一个方案不等于任务完成，报"已完成"会让他以为改动已经发生。
- **未产出计划**（模型没给出可用内容）不是静默收场：给出一条明确的提示（建议补更具体的信息或关掉开关），
  以 `reason: 'error'` 收尾。
- 该能力经 `initialize` 返回的 `capabilities.plan` 声明（可选，老客户端忽略即可）。
- 审批迹线以 `trajectory.record { kind: 'plan' }` 记录（`plan.request` 与 `plan.respond` 各一条）。

### `model`（真实模型接入）

`initialize.model` 声明模型底座，daemon 端据此构建真实 Agent：

- `baseURL?: string` —— OpenAI 兼容端点 base，缺省 `https://api.deepseek.com/v1`
- `model?: string` —— 模型名，缺省 `deepseek-flash`（DeepSeek 思考模式会流式返回 `reasoning_content`，投影为 `reasoning.delta`）
- `apiKey?: string` —— 优先于顶层 `initialize.apiKey`
- `agent?: 'mock' | 'real' | 'auto'` —— 实现选择；缺省 `auto` = 有 apiKey 则 real，否则 mock
- `idleTimeoutMs?: number` —— **模型请求空闲超时**（P0-3）：距上一个流式增量超过该时长即以
  `TimeoutError` 中断本次请求，避免模型端静默（网关挂住 / 连接半开 / 服务端排队）时会话永久
  卡在 `running`。缺省 60000；`<= 0` 关闭。会话取消（`session.cancel`）另走 `AbortController`
  立即中断在途请求，与空闲超时相互独立。
- `maxToolRounds?: number` —— **工具调用轮数上限**：跑满后 Agent 收束成一次不带工具定义的最终
  回答（不再给模型调工具的机会）。缺省 8。
- `maxContextTokens?: number` —— **上下文 token 预算**：发送前按此估算并裁剪历史，超出时**整轮**
  丢弃最旧的工具轮次（保留 system + 用户原始请求 + 最近轮）。缺省 48K。
- `temperature?: number` —— **采样温度**（0–2）。未提供时沿用 daemon 缺省 `0.2`。
  注意 Anthropic 的合法区间是 **0–1**：越界值在模型层被钳制后发出，不会原样透传
  （原样透传只会换来一个与配置无关的 400）。
- `maxTokens?: number` —— **单次输出上限**（`max_tokens`）。未提供 / `<= 0` 表示
  **不发送该字段**，上限交由服务端决定（OpenAI 兼容端点）；Anthropic 的 `/v1/messages`
  把 `max_tokens` 列为必填，故未配置时回落 4096。

  后四个字段都是**可选**的：客户端不下发时 daemon 使用缺省值，行为与引入这些字段之前一致
  （尤其 `temperature`：缺省仍是 0.2，而不是"客户端必须显式声明"）。

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
- `approvalTtlMs?: number` —— **挂起项超时**（`approval.request` / `file.patch.pending` / `plan.request`）毫秒数；
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
- `image`：用户附加的图片（截图 / 图片文件），字段与限额见下

#### 图片附件（P2-4）

粘贴截图（Ctrl+V）、把图片拖进输入框、或点输入框左侧的图片按钮选择文件，都会作为 `kind: 'image'` 的附件发出：

| 字段 | 说明 |
| --- | --- |
| `mimeType` | 白名单内取值：`image/png` / `image/jpeg` / `image/webp` / `image/gif` |
| `dataBase64` | 图片字节的 base64（**不含** `data:` 前缀、不含换行） |
| `sizeBytes?` | 原始字节数；daemon **不采信**这个值，按 base64 长度重算（它既可能过期，也可能是编的，而限额判定直接依赖它） |
| `name?` | 文件名，仅用于 `[图片 N：名字]` 标记 |
| `clientId?` | 客户端生成的临时标识：扩展据此把回显 chip 与本地缩略图对上。daemon 不解释它 |

限额（超限时**整条消息拒绝**，返回 `-32602`，**不**静默丢弃单张）：

- 单条消息最多 4 张 · 单张 ≤ 5 MB · 合计 ≤ 12 MB
- 越限时 daemon 同时发 `error` 与 `session.ended { reason: 'error' }`，且**不发 `session.started`** —— 模型一次都不会被调用

`initialize` 的 `capabilities.image` 声明该实现支持图片附件（可选，老客户端忽略即可）。

**为什么 daemon 侧要再校验一次**：daemon 是安全边界，协议允许任意客户端接入（`examples/python-daemon` 就是活证据）。
"要发给模型"的内容必须在真正使用它的那一刻再验一次，而不是信任上游已经校验过。

**为什么整条拒绝而不是丢掉那张**：这类消息里的图片通常**就是提问本身**（"看这个报错截图"）。
静默少发一张会让模型对着一张根本不存在的图作答，用户拿到一段看起来完全正常的胡话；
而"明确告诉你第 2 张没附上、为什么"最多只是让用户重发一次。

图片**不折进文本**：它作为独立内容块参与请求（OpenAI 兼容 = `image_url` 的 data URL / Anthropic = `source.base64` 块），
文本侧只留一行位置标记 `[图片 N：名字]`（多张时模型据此知道"第 2 张"指哪一张）。要点：

- 纯文本消息仍是**裸字符串** —— 不带图片的请求体与"图片能力存在之前"逐字节一致；有图片才升格为内容块数组。
- 图片**没有**文件路径（字节全程只在消息里），因此不存在 `file`/`selection` 那类路径逃逸面，攻击面只剩"体积"与"格式"。
- `prompt` 允许为空串：只粘一张图直接发送是常见用法。
- 图片按 `IMAGE_TOKEN_ESTIMATE`（2048）计入上下文预算 —— 宁可略保守：估松了会被服务端以超长拒绝，估紧了只是多裁一轮旧工具结果。

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
| `plan.request` | **挂起点**：计划模式下方案待批准（planId/plan/expiresAt） |
| `file.patch.result` | 补丁决策结果（accepted/applied/error） |
| `trajectory.record` | 迹线步骤（step/kind/detail/ts，另含可选结构化字段 tool/ok/durationMs/errorKind/tokens，见 §6；`kind` 取值含 `reasoning` / `message` / `tool` / `approval` / `patch` / `plan` / `system`） |
| `session.ended` | 会话结束（reason: completed/canceled/error） |
| `error` | 协议/运行错误（code 取值见错误码表） |

## 5. 会话状态机、审批/补丁挂起-恢复、续跑与心跳

### 状态机

每个会话独立维护状态：`idle -> running -> (pending_approval | pending_patch | pending_plan) -> running -> idle`

```
session.send ──> (流式事件...) ──> approval.request ──挂起──> approval.respond ──> tool.executed ──> session.ended
                                ├─> file.patch.pending ──挂起──> file.patch.respond ──> file.patch.result ─┤
                                └─> plan.request ──挂起──> plan.respond ──批准──> (执行循环) ─────────────┘
```

- **并发**：状态为 `idle` 才允许 `session.send`（同一会话返回 `-32009 Busy`）；**不同会话可并行**（多会话并发）。
- **挂起强校验**：`approval.respond` / `file.patch.respond` / `plan.respond` 校验 id 归属；不存在的 id 返回 `-32013 NotFound`；
  超过 `expiresAt`（默认 60s）返回 `-32010 Expired`，且到点自动按"拒绝"解析以解除挂起。
- **取消**：`session.cancel` 置 canceled 标记并将挂起项按拒绝解除，Agent 收尾发出 `session.ended(reason=canceled)`。

### 断线续跑（session.resume）

- daemon 为每个会话维护**事件环形缓冲**（默认 2000 条）：断线期间事件照常入缓冲（不丢失）。
- 重连后客户端以原 `sessionId` 调用 `session.resume`：daemon **重放缓冲事件**并返回当前
  `state` 与挂起快照（`pendingApproval` / `pendingPatch` / `pendingPlan`，含 `expiresAt`），UI 据此恢复审批/补丁/计划卡片。
- daemon 进程重启后会话丢失，`resume` 返回 `-32013 NotFound`，客户端回退 `session.create` 新建会话。

### 心跳

客户端每 15s `ping`，连续 3 次无响应判定链路死亡并强制重连（重连后走 resume 恢复）。

## 6. 迹线（Trajectory）数据映射

对应方案中"迹线数据映射"要点：daemon 内部轨迹（模型调用、工具调度、审批、补丁、状态变化）
以 **`trajectory.record` 事件流**投影到 VSCode 侧，每条记录包含：

- `step`：会话内单调递增的步骤号（用于 UI 时间线与回放）
- `kind`：`reasoning | message | tool | patch | approval | plan | system`
- `detail`：人类可读的步骤摘要
- `ts`：epoch 毫秒时间戳

**结构化字段（P2-8，全部可选）** —— `detail` 保留"给人读的原文"（含命令原文、路径），
下列字段供**统计/聚合**使用。二者并存而非替代：只留 `detail` 则无法聚合，只留字段则失去可核对的原始记录。

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `tool` | `string` | 工具名（`kind` 为 `tool` / `approval` 时） |
| `ok` | `boolean` | 该步骤是否成功（`kind` 为 `tool` 时；非工具步骤通常不填） |
| `durationMs` | `number` | 耗时（毫秒） |
| `errorKind` | `string` | 失败分类，仅 `ok === false` 时有意义。取值：`policy-denied`（被命令策略拒绝）、`tool-disabled`（`allowedTools` 未包含）、`approval-denied`（用户拒绝审批/补丁/计划）、`timeout`、`exec-failed`、`internal` |
| `tokens` | `{ prompt?, completion?, total?, estimated? }` | 模型调用的 token 用量；`estimated: true` 表示**本地估算**而非网关返回的真实用量 |

- **向后兼容是硬要求**：`.dsh/trajectory/*.jsonl` 是已落盘的审计数据，新增字段不得使历史记录不可解析
  （旧记录没有这些字段，消费方按"未知/不适用"处理即可）。
- **脱敏覆盖所有字符串字段**（不只 `detail`）：新增字段不会成为凭据写入审计日志的旁路。
- 典型聚合：按 `tool + ok` 统计"哪类工具最容易失败"；按 `errorKind` 区分"策略拦下"与"用户拒绝"（二者都是
  非错误，却常被笼统记成"失败"）；对 `tokens.total`（`estimated`）求和得到**单会话成本量级**。
  注意估算值与账单无关，不得用于计费核对。

### 审批风险分级（P2-9）

`approval.request.risk`（`low | medium | high`）由 **daemon 按命令内容分级**，不再是常量：

- `high`：删除 / 破坏性 / 系统级（`rm -rf`、`del /f /s /q`、`format`、`dd`、`mkfs`、`shutdown`、
  `git reset --hard`、`git clean -fdx`、`git push --force`、`kill` 等）
- `medium`：写文件 / 访问网络 / 改变版本库状态（`mv`、`cp`、`sed -i`、`chmod`、重定向写文件、
  `npm install`、`pip install`、`curl` / `wget`、`git commit|push` 等），以及**未知命令**的保守兜底
- `low`：只读（`ls`、`cat`、`grep`、`git status|log|diff`、`node --version` 等）

规则：复合命令（`&&` / `||` / `;` / `|`）**取各片段中的最高等级**；`reason` 文案随等级变化。

> **`low` 不等于免审批。** 风险等级只影响 UI 的呈现强度（配色 / 文案 / 二次确认），
> 是否发起审批由命令策略与信任白名单决定。客户端不得据 `risk` 跳过人工确认。

VSCode 侧将轨迹渲染为「执行迹线」面板（顶栏图标按钮按需打开，不常驻占位），并可据此实现审计、回放与失败定位；
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
