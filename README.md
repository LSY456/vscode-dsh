# vscode-dsh — 开箱可用的 VSCode 本地 Agent

**vscode-dsh** 是一个**自带 Agent 内核、装上就能用**的 VSCode 编程助手。模型路由、工具沙箱、
会话状态全部跑在一个独立的本地 **daemon 进程**里，编辑器侧只负责"上下文捕获 + 交互面板"，
两者通过 **JSON-RPC 2.0 over WebSocket** 解耦通信。

它同时存在于三个层次，从"直接用"到"自己接内核"：

| 层次 | 是什么 | 谁需要 |
| --- | --- | --- |
| **1 · 开箱可用的本地 Agent** | 仓库内置**完整 Agent 内核**（`src/daemon/realAgent.ts`）：原生 function calling + fenced 兜底解析、工具沙箱、审批门控、原生 Diff 审查、上下文 token 预算、可中断请求 + 空闲超时、脏文档一致性。**配好模型 Key 即用**，不依赖任何外部组件 | 想直接拿来写代码 |
| **2 · 开放协议 + 参考实现** | 协议契约（[PROTOCOL.md](PROTOCOL.md)）+ **两个可运行实现**：本仓库的 Node daemon，以及一个换语言的 [Python 参考 daemon](examples/python-daemon/dsh_daemon.py)（仅标准库、手写 WebSocket）。第三方内核实现同一协议即可接入（`dsh.daemon.mode=external` + `dsh.daemon.command`） | 想换内核 / 接自研 Agent |
| **3 · mock agent** | 关键字驱动的模拟循环，**仅用于测试与离线演示**：不接真实模型也能端到端跑通协议、审批、补丁、续跑全流程 | 读代码 / 跑测试 / 断网演示 |

`auto`（缺省）决定走哪条：**配了模型 Key 就走层次 1 的真实内核**，否则回落到层次 3 的 mock。
回落不是静默的——未配 Key 时面板顶部会出现醒目的**「演示模式」横幅**并给出配置入口，
不会让你把模拟回复当成真实模型的回答。关键字语义见 [docs/mock-agent.md](docs/mock-agent.md)。

> 📚 相关文档：[协议规范](PROTOCOL.md) · [变更日志](CHANGELOG.md) · [贡献指南](CONTRIBUTING.md)

---

## 它能带来什么

| 能力 | 说明 |
| --- | --- |
| 🧠 **Agent 独立成 daemon** | 模型路由、工具调度、会话状态全部下沉到独立进程，与编辑器解耦；长任务不再拖垮编辑器，同一 Agent 内核可复用于 CLI / Web / 其他 IDE。注意：daemon 由扩展宿主 `spawn`、并在 `deactivate()` 时被回收，**它不跨窗口存活**；但同一工作区的多个窗口可复用同一个 daemon（能力/脏文档覆盖层按连接隔离，互不污染） |
| 📎 **上下文不失真** | 发送 Prompt 时自动打包活动文件全文、高亮选区（带行号）、编译诊断、git status 为结构化附件，不再需要手动复制粘贴、不再丢失编辑现场 |
| 🖼️ **图片也能直接问** | 报错截图直接粘贴（Ctrl+V）/ 拖进输入框 / 点图片按钮选择，图片作为**独立内容块**发给模型（OpenAI 兼容 `image_url` / Anthropic `source.base64`），文本侧保留 `[图片 N]` 位置标记；限额在扩展与 daemon **各校验一次**，不合规**整条拒绝**而不是静默少发一张 |
| 🛡️ **改动可控** | 高危工具调用必须过**审批卡**（Human-in-the-Loop）；文件修改必须先看**原生 Diff 并排视图**再决定落盘——把"AI 盲改"变成"AI 提议、人拍板" |
| 📋 **计划模式** | 可以要求 Agent **先出方案再动手**：调研阶段只读、给出一份可审阅的计划（目标 / 步骤 / 涉及文件 / 风险），**批准后才进入执行**。想清楚再改，避免"边想边改"把仓库改花 |
| 🔒 **安全边界干净** | 工具在独立 daemon 进程执行，仅监听 127.0.0.1 随机端口，WS 握手必须带一次性 Bearer token、拒绝带浏览器 Origin 的连接 |
| 🔌 **协议化可插拔** | 一份明确 JSON-RPC 契约（方法/事件见 [PROTOCOL.md](PROTOCOL.md)），前端可换（VSCode / JetBrains / CLI），后端可换（内置内核 / 第三方 daemon / 自研 Agent）——而且**有两个可运行的实现**（Node + [Python](examples/python-daemon/dsh_daemon.py)）来证明它，不是纸面承诺 |
| 📜 **全程可追溯** | daemon 内部轨迹以 `trajectory.record` 事件流投影到 UI 的"执行迹线"面板，步骤级审计、回放与失败定位 |

## 它解决什么痛点

1. **Agent 内核被锁死在编辑器进程里** —— Cline / Roo 类扩展把 Agent 逻辑直接写进扩展宿主，
   崩溃连累编辑器、能力无法复用、状态随窗口生灭；daemon 化把"传感器 + 遥控器"（VSCode）与
   "大脑"（Agent）彻底分开。
2. **AI 不了解你的编辑现场** —— 手动把代码贴进聊天框会丢选区位置、丢文件结构、丢编译错误；
   本插件自动捕获"文件 + 选区 + 诊断 + git 状态"，上下文永远和屏幕一致。
3. **AI 盲改代码、不敢放权** —— "一键生成→直接写盘"摧毁信任；本插件把每个敏感动作显式化：
   高危工具要审批、文件修改先 Diff 审查，信任可以逐步建立。
4. **安全边界不干净** —— 扩展宿主里直接跑 bash / 写文件，等于把最高权限放进一个被 Webview 等
   面攻击的进程；本插件让工具在隔离的本地 daemon 中执行，并有 token + Origin 双层门禁。
5. **每次集成都要重写一遍 Agent** —— 有了协议契约，前端与后端各自独立演进，一次对接、处处复用。

## 架构

```
┌─────────────────────────────────────────────────────────┐
│                      VSCode 进程                         │
│  ┌───────────────────────┐   ┌───────────────────────┐  │
│  │ Webview View (UI)     │   │ Extension Host        │  │
│  │  - Chat / Plan Panel  │   │  - Editor Context     │  │
│  │  - Reasoning Stream   │   │  - File System Access │  │
│  │  - Tool Approval Card │   │  - Diff Provider      │  │
│  └───────────┬───────────┘   └───────────┬───────────┘  │
└──────────────┼───────────────────────────┼──────────────┘
               │ Event / Commands          │ Local Protocol
               └─────────────┬─────────────┘
                             ▼
┌─────────────────────────────────────────────────────────┐
│          dsh Agent Daemon（内置内核 / 第三方实现）       │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │ Model Adapter│  │ Tool Sandbox │  │ Trajectory   │   │
│  └──────────────┘  └──────────────┘  └──────────────┘   │
└─────────────────────────────────────────────────────────┘
```

关键决策：

- **Webview 不直连 daemon**：所有 WebSocket 流量只存在于 Extension Host ↔ daemon 之间
  （127.0.0.1 随机端口 + 一次性 Bearer Token + Origin 校验），Webview 通过 `postMessage` 与扩展桥接。
- **双向事件流**：daemon 侧 `reasoning.delta / message.delta / tool.* / approval.request /
  file.patch.pending / trajectory.record` 增量下发；扩展侧 `approval.respond / file.patch.respond /
  session.cancel` 回传决策。协议契约见 [PROTOCOL.md](PROTOCOL.md)。
- **扩展运行在工作区侧（`extensionKind: ["workspace"]`）**：daemon 由扩展宿主 `spawn`、工作区根取自
  `workspaceFolders`，所以 Remote-SSH / WSL / Dev Containers 场景下扩展必须加载在**远端工作区侧**
  才能拿到真实路径与进程环境（否则会在 UI 侧启动一个进程、拿着远端不存在的本地路径干活）。
- **原生 Diff 审查**：补丁不直接落盘，先以虚拟文档（scheme `dsh-patch`）打开 `vscode.diff`
  并排视图，用户确认后才回传 `file.patch.respond(accept)` 由 daemon 写盘。

## 四个关键流程

1. **生命周期与握手**：`DaemonManager` 探测工作区 `.dsh/daemon.json` → 无则静默拉起
   `node out/daemon/index.js`（随机端口、token 走环境变量）→ WebSocket 连接 → `initialize`
   握手（workspaceRoot / apiKey / preset）→ 断线指数退避重连。
2. **主动上下文捕获**：发送 Prompt 前由 `contextCapture.ts` 自动打包活动文件全文、高亮选区、
   `vscode.languages.getDiagnostics` 诊断、git status 为结构化 `attachments`。
3. **流式推理 + 工具审批循环**：推理/回答增量实时渲染；高危工具触发 `approval.request`
   挂起 Agent 循环，UI 渲染 [接受/拒绝] 卡片，确认后恢复。
4. **代码修改与 Native Diff 预览**：`file.patch.pending` → 虚拟文档 + `vscode.diff` 并排视图 →
   用户点击应用/拒绝 → `file.patch.respond` → daemon 写盘并回 `file.patch.result`。

## 快速开始

```bash
# 1. 安装依赖（首次）
npm install

# 2. 构建（扩展宿主 + daemon + webview 静态资源）
npm run build          # 或 npm run watch 增量

# 3. 验证协议闭环（不依赖 VSCode）
npm test                    # 单元测试（vitest，759 用例）
npm run smoke               # 端到端冒烟：安全握手/补丁/审批/取消/并发/续跑/真实 Agent 流水线
npm run smoke:protocol      # 协议「第二实现」：用 Python 参考 daemon 跑通同一份协议
                            #（缺 Python 3 时优雅跳过；`npm run smoke:protocol -- --require` 则判失败）

# 4. 配置真实模型（可选）：打开面板 → 设置，只需填 API Key（SecretStorage 安全存储）；
#    模型名从下拉里选（列表自动跟随 DeepSeek 官方更新，无需手写）；
#    或直接配置 dsh.model.model / dsh.model.baseURL（旧 dsh.apiKey 明文配置会自动回迁到
#    SecretStorage 并清除，不再落盘 settings.json）

# 5. 在 VSCode 中按 F5 启动 Extension Development Host
```

启动后：

- **点活动栏的 dsh 图标**即可打开 `Agent` 侧边栏面板（常驻入口）；也可用命令
  **`dsh: 打开 Agent 面板`**，或点状态栏的 `dsh` 图标（绿点=已连接）。
- 面板顶栏是图标动作组：**新建会话** / **历史会话**（点任意会话即切回，可继续对话，daemon 重启过则只读回放）
  / **回滚本会话改动**（还原到会话开始前）/ **执行迹线**（按需打开的审计面板，按钮上带步骤计数）
  / **模型设置**；顶栏同时显示当前会话标题，
  连接状态、当前 Agent 实现与**账户余额**显示在输入区下方的状态行（余额 chip 悬停看赠金/充值明细，
  点击立刻重取；只在 DeepSeek 官方端点上取，拿不到就整块隐藏）。
- **会话级回滚**：`dsh: 回滚本次会话的文件改动`（命令面板 / 面板顶栏；执行前有模态确认）。daemon 在每个文件
  **第一次被改动之前**留一份影子快照（`.dsh/snapshots/<会话>/`，只增不改），回滚即把文件还原到本次会话开始前、
  本次新建的文件被删除。审批是"事前拦截"，回滚是"事后兜底"。两种"别动它"的情况一律**跳过并如实汇报**：
  目标文件此刻在编辑器里有未保存改动，或它在本次会话之后**又被改过**（比如你手工编辑并保存了）——
  绝不覆盖你的改动。结果按类分列（还原 / 删除 / 脏跳过 / 内容已变 / 不可还原 / 失败 / 未记录），
  不会压成一句"回滚完成"。
- **计划模式**：输入框左侧的**「计划」开关**（默认关闭，开着就一直是计划模式，直到你再点一次）。打开后这一轮 Agent
  **只调研、只出方案**：可用工具收窄到 `read_file` / `list_dir` / `grep` / `glob` —— 写入类工具**根本没有被提供**
  （不是靠提示词请它自觉），接着给出计划卡（目标 / 按序步骤 / 涉及文件 / 风险与待确认）挂起等你拍板。
  **批准**才进入执行（可附一句补充意见，执行时以它为准）；**拒绝**则什么都没改就停下，会话以「已取消」收尾并
  明说「没有改动任何文件」。调研轮次有**独立预算**，不会挤占批准后的执行轮次。
- **发图片**：把截图直接粘进输入框（Ctrl+V）、把图片文件拖进输入框、或点输入框左侧的 🖼 按钮选择文件。
  图片先暂存在输入框上方（可逐张删除），发送时随消息一起交给模型 —— 报错截图用它比文字描述快得多。
  限额：单条最多 4 张 · 单张 ≤ 5 MB · 合计 ≤ 12 MB（支持 png / jpeg / webp / gif；GIF 不压缩以免丢动图），
  大图在发送前自动缩到长边 1568px。超限时**整条消息会被拒绝**并说明原因（那张图往往就是问题本身，
  静默少发一张比直接报错更难发现）。图片只存在于会话消息里，不会被写进工作区。
- 需要大屏审阅时用 **`dsh: 在编辑器列打开 Agent`**，侧边栏与编辑器列两个视图共享同一会话状态。
- 编辑器选中代码后右键 **`dsh: 将选中代码发送给 Agent`**。
- 补丁 Diff 的**标题栏**带 `应用 / 编辑后应用 / 拒绝` 按钮，不必回面板点。
- 在面板输入自然语言即可，例如 `解释当前文件的关键逻辑` / `请修改当前文件中的 TODO`。
  配了模型 Key 时由真实内核处理；**未配 Key 时面板顶部会出现「演示模式」横幅**，
  此时落到 mock agent，靠关键字触发特定分支（关键字表见 [docs/mock-agent.md](docs/mock-agent.md)）。
- 命令 `dsh: 重启 Daemon` / `dsh: 查看 Daemon 状态` / `dsh: 调试 - 打印捕获的上下文`。

## 配置项（settings.json）

| key | 默认 | 说明 |
| --- | --- | --- |
| `dsh.daemon.mode` | `auto` | `auto` 自动拉起 / `external` 连接已有 daemon / `none` 仅 UI |
| `dsh.daemon.command` | `""` | 外部 daemon 启动命令模板（支持 `{portFile} {workspace} {token}` 占位） |
| `dsh.daemon.port` | `0` | `external` 模式端口 |
| `dsh.daemon.token` | `""` | `external` 模式握手令牌 |
| `dsh.apiKey`（已弃用） | `""` | 旧版明文 API Key；首次读取自动回迁到 SecretStorage 并清除，推荐改用「面板 → 设置」 |
| `dsh.preset` | `default` | 握手时传给 daemon 的 Agent 预设（行为档位名，不是模型名）；当前只有 `default` 一档，且该值只被记录、不影响行为 |
| `dsh.model.baseURL` | `https://api.deepseek.com/v1` | 模型 API 端点 base（OpenAI 兼容） |
| `dsh.model.model` | `deepseek-flash` | 模型名。建议在侧边栏「模型设置」里从下拉选择（列表自动跟随 DeepSeek 官方更新） |
| `dsh.model.idleTimeoutSeconds` | `60` | 模型请求空闲超时秒数（0–1800，0 = 关闭）；距上一个流式增量超时即中断，防会话永久挂起 |
| `dsh.model.temperature` | *（空）* | 采样温度 0–2；**留空 = 内置缺省 `0.2`**（留空时 daemon 根本不下发该值，行为与引入本项之前逐字节一致）。Anthropic 合法区间是 0–1，超出会被钳制 |
| `dsh.model.maxTokens` | *（空）* | 单次输出上限；留空 = **不发送该字段**，由服务端决定上限。Anthropic 把 `max_tokens` 列为必填，留空时回落 4096 |
| `dsh.agent.maxToolRounds` | `8` | 单轮会话最多工具调用轮次（1–50）；跑满后强制收束（`requestFinalAnswer`），不带工具再问一次给出正文 |
| `dsh.agent.maxContextTokens` | `49152` | 上下文预算 token 数（4000–1000000）；超出后按滑动窗口丢弃最旧的工具轮次（保留系统提示与用户原始消息） |
| `dsh.context.gitStatus` | `true` | 附带 git status（失败静默跳过） |
| `dsh.context.maxFileBytes` | `200000` | 附件内联内容阈值；超出改为 `contentOmitted` 按需 `file.read` |
| `dsh.diff.autoOpen` | `true` | 补丁到达时自动打开 Diff 视图 |
| `dsh.history.maxSessions` | `50` | 会话历史保留条数（0–10000，0 = 不限）；超出按创建时间裁剪最旧的 |
| `dsh.capabilities.allowedTools` | `[]` | 工具白名单（空 = 全部允许），如 `["bash_execute"]` |
| `dsh.capabilities.maxConcurrency` | `0` | daemon 全局并发会话上限（0 = 不限） |
| `dsh.approval.ttlSeconds` | `60` | 审批 / 补丁 / 计划挂起的超时秒数（10–3600，到点按拒绝处理；改后重启 daemon 生效） |

## 目录结构

```
vscode-dsh/
├── package.json            # 扩展清单（命令/配置/激活事件）
├── esbuild.js              # 构建：extension + daemon + media
├── shared/protocol.ts      # ★ 协议契约（两端共享，真实 daemon 必须兼容）
├── shared/version.ts       # 单一版本来源（扩展宿主与 daemon 共用）
├── src/
│   ├── extension.ts        # 入口：命令、状态栏、组装
│   ├── daemonManager.ts    # 进程生命周期：探测/拉起/连接/续跑/心跳/回收
│   ├── wsClient.ts         # JSON-RPC over WS 客户端（心跳、错误码透传）
│   ├── contextCapture.ts   # 主动上下文捕获（文件/选区/诊断/git，大文件按需读取）
│   ├── diffProvider.ts     # 虚拟文档 + vscode.diff + 补丁审批
│   ├── webviewPanel.ts     # Webview 面板宿主与消息桥
│   ├── sessionHistory.ts   # 会话历史持久化（FileMemento，工作区 .dsh/history.json）
│   ├── configAccessor.ts   # 配置存取（apiKey SecretStorage 安全化 + 面板数据源）
│   ├── logger.ts           # OutputChannel 分级日志
│   └── daemon/
│       ├── index.ts        # daemon CLI 入口（--agent mock|real|auto --fake-model）
│       ├── server.ts       # WS/JSON-RPC 服务端（安全握手/能力分级/resume/file.read/agent 切换）
│       ├── sessionManager.ts # 会话状态机 + 事件缓冲 + 审批/补丁/计划强校验（纯逻辑，可单测）
│       ├── paths.ts        # 路径护栏（canonical，防 symlink/junction 逃逸）
│       ├── agent.ts        # 模拟 Agent 循环（mock 实现，演示/测试用）
│       ├── realAgent.ts    # 真实 Agent 循环（模型 + 工具 + 审批门控 + 计划模式）
│       ├── planMode.ts     # 计划模式单一来源（只读工具白名单 + 各阶段提示词）
│       ├── model.ts        # 模型适配层（OpenAI 兼容流式 + Anthropic Messages + FakeChatModel）
│       ├── tools.ts        # 真实工具沙箱（只读搜索/写入 Diff 审查/bash 策略门控）
│       ├── toolcall.ts     # 模型工具调用 fenced 块协议
│       ├── trust.ts        # 信任记忆（免审批白名单，.dsh/trust.json）
│       ├── sandbox.ts      # 命令执行沙箱（bubblewrap 命名空间 / 应用层兜底，可插拔后端）
│       ├── logFile.ts      # daemon 日志落盘（.dsh/logs/daemon.log，轮转 + 0600）
│       └── trajectoryStore.ts # 轨迹持久化（.dsh/trajectory/*.jsonl）
├── media/                  # Webview 静态资源（HTML/CSS/JS）
├── resources/              # 活动栏图标等随包资源（dsh-activity.svg）
├── examples/
│   └── python-daemon/      # ★ 协议第二实现：Python 3 + 仅标准库，手写 WebSocket 服务端
├── scripts/
│   ├── smoke.js            # 端到端冒烟测试（无 VSCode 依赖）
│   ├── smokeProtocol.js    # 协议「第二实现」冒烟：驱动上面的 Python daemon
│   ├── smokeReal.js        # 真实 endpoint 连通冒烟（可选，需 apiKey，不参与 CI）
│   └── runIntegrationTests.js  # @vscode/test-electron 集成测试入口
├── *.test.ts               # vitest 单元测试（协议/路径/状态机/Agent/模型/工具/轨迹）
├── .github/workflows/ci.yml # CI：typecheck/build/unit/smoke/协议第二实现 + VSIX 构件
├── PROTOCOL.md             # 协议规范
├── CHANGELOG.md            # 变更日志
├── CONTRIBUTING.md         # 贡献指南
├── SECURITY.md             # 安全策略
├── LICENSE                 # MIT 许可证
└── .gitignore              # 忽略 node_modules / 构建产物 / 缓存 / 运行时状态等
```

## 安全设计

- **工作区信任门禁（P0-1）**：未受信任的工作区（受限模式）**不启动 daemon** —— 它会读写工作区文件、
  执行命令、并在 `.dsh/` 下落盘会话记录。同时把会执行代码 / 触及网络 / 放开工具白名单 / 携带凭据的
  配置项（`dsh.daemon.command`、`dsh.daemon.mode`、`dsh.daemon.port`、`dsh.daemon.token`、
  `dsh.capabilities.allowedTools`、`dsh.model.baseURL`、`dsh.apiKey`）声明为受限配置，并把其中会执行进程的钉成
  **机器作用域**（工作区设置无法改写）—— 否则仓库里放一份 `.vscode/settings.json` 就能在用户点开面板时
  执行任意进程。受限时面板横幅与状态栏会说明原因并提供「信任此工作区」入口（命令 `dsh: 信任此工作区`）；
  信任后自动补齐启动，无需重启窗口。
- **不猜工作区根（P0-2）**：没有打开文件夹时**明确拒绝启动**（状态「仅 UI 模式」+ 指引先打开文件夹），
  而不是回落 `process.cwd()` —— 后者会让"工作区"变成扩展宿主的工作目录，端口文件、`.dsh/` 与路径护栏
  的根全跟着跑偏。工作区根由 `src/workspaceRoot.ts` 单点解析（多根只取第一个并在日志中说明）。
- **`.dsh/` 自守（P0-3）**：首次创建 `.dsh/` 时自动写入 `.gitignore`（内容 `*`）—— 目录里是对话全文
  （`history.json`）、工具输入输出（`trajectory/*.jsonl`）、日志与信任规则，不该出现在你的 `git status`
  里，更不该被 `git add -A` 带进仓库。已存在的 `.gitignore` 不会被覆盖。
- **端口**：daemon 仅监听 `127.0.0.1` 随机端口；端口经 stdout/端口文件上报，不暴露公网；
  对非 WebSocket 升级请求返回 **404 空响应**（不回 426，那等于告诉探测者"这里有个 WS 端点"）。
- **回收陈旧 daemon 前核对进程身份**：pid 取自 `<workspace>/.dsh/daemon.json` —— 一个本机任意进程
  都能写的文件。pid 复用或文件被篡改时，无条件 `process.kill` 就是**杀别人的进程**。现在先读该进程的
  命令行，确认它确实是本扩展拉起的 daemon 入口脚本才动手；读不到命令行（权限不足 / 探针不可用）
  同样按"身份不明"处理 —— **失败关闭，宁可不杀**（代价只是留一个会自行退出的孤儿进程）。
- **一次性 Token**：扩展生成 24 字节随机 token，经环境变量传给 daemon 子进程；WS 打开握手必须
  携带 `Authorization: Bearer <token>`；拒绝任何带浏览器 `Origin` 的连接（防跨站 WebSocket 劫持）。
- **能力分级**：握手时声明 `allowedTools / allowedDirs / maxConcurrency`，越权工具直接禁用
  （不发审批）、越界路径一律拒绝（`-32012`）。
- **路径护栏（canonical）**：patch / `file.read` / 附件读取目标以 `fs.realpathSync` 解析后的
  **规范路径**做包含判断，拒绝 `..` 逃逸、符号链接/目录联结（junction）逃逸、NUL 与 Windows ADS。
- **审批/补丁/计划强校验**：id 归属校验（`-32013`）+ 60s 过期（`-32010`，UI 倒计时置灰）。
- **命令默认拒绝 + 审批风险分级**：`bash_execute` 在内置高危拒绝规则（`rm -rf`、fork bomb、格式化、
  `curl|sh`、shutdown 等）之外，还需人工审批；普通命令亦须审批。审批卡不再一律显示"高危"——
  按命令内容分**删除/破坏 → 高、写文件/网络/未识别 → 中、只读 → 低**三档，复合命令（`&&`/`||`/`;`/`|`）
  取各片段**最高级**，未识别命令按**中**兜底（把未知当低危，等于让没见过的写法自动获得更弱的提示）。
  **低危不等于免审批**：等级只影响界面提示强度，免审批仍然只由信任白名单决定。
- **密钥脱敏 + 权限**：轨迹持久化前统一脱敏密钥 / Token / 密码词面，且**遍历记录里所有字符串字段**
  （每新增一个字段都可能是一条新的明文旁路）；轨迹目录 `0700`、文件 `0600`。
- **余额只在官方端点取**：账户余额（`GET /user/balance`）只在 `api.deepseek.com` 上请求 —— 它是
  DeepSeek 的**账户级**接口，用户自配的第三方网关未必有它，也不该为"锦上添花的展示"把 API Key
  送到第三方去。非官方端点直接视为「不适用」（界面隐藏该 chip），不产生必然的 404。
- **Webview 隔离**：CSP `default-src 'none'` + nonce 脚本；Webview 无网络权限，仅经扩展中转。
- **补丁落盘护栏**：Agent 修改文件必须经过 Diff 审查；拒绝即不写盘（参考 daemon 在收到
  `file.patch.respond(accept)` 后才写）。


## 迹线（Trajectory）数据映射

daemon 内部轨迹以 **`trajectory.record` 事件流**投影到 VSCode，每条含
`step / kind(reasoning|message|tool|patch|approval|plan|system) / detail / ts`，并可带**可选结构化字段**
（`tool` / `ok` / `durationMs` / `errorKind` / `tokens`）—— 为"哪类工具最容易失败""单会话 token 成本"
这类统计铺路，旧记录缺这些字段照常解析；UI 渲染为可折叠的"执行迹线"面板（行尾显示失败分类 / 耗时 /
`≈N tok` 徽标），用于审计、回放与失败定位。其中 `tokens` 是 daemon 侧的**本地估算**（`estimated: true`），
**不是账单**。详见 [PROTOCOL.md §6](PROTOCOL.md#6-迹线trajectory数据映射)。

## 接入自己的 Agent 内核

扩展侧只依赖 [PROTOCOL.md](PROTOCOL.md) 里的契约，不依赖任何实现。三种姿势，按侵入程度递增：

1. **什么都不做** —— 用内置内核：配好模型 Key 走 `realAgent`（层次 1），没配则落到 mock 并在面板
   顶部显示「演示模式」横幅（层次 3）。
2. **换一个 daemon 进程** —— 启动你自己的 daemon，实现 `DSH_DAEMON_PORT=<port>` 端口上报与同一协议，
   然后二选一：
   - `dsh.daemon.mode = external` + `dsh.daemon.port` / `dsh.daemon.token`
   - `dsh.daemon.command`（模板，支持 `{portFile}` `{workspace}` `{token}` 占位符；auto 模式优先使用它）

   最小可跑样例就是 [examples/python-daemon/dsh_daemon.py](examples/python-daemon/dsh_daemon.py)：
   仅用标准库、WebSocket 服务端手写，`npm run smoke:protocol` 可以看到它被完整驱动一轮。
3. **换一套前端栈** —— 协议与传输（JSON-RPC 2.0 over WebSocket）不绑定编辑器，同一个后端可给
   CLI / 其他 IDE 复用。

协议细节以 `shared/protocol.ts`（两端共享的类型与守卫）与 [PROTOCOL.md](PROTOCOL.md) 为准。
第二实现能跑通，说明契约里没有夹带 Node 侧的实现细节。



## 已知局限

- 模型支持 OpenAI 兼容端点（DeepSeek/OpenAI/通义/本地推理等）与 Anthropic Messages，经 `dsh.model.provider` 选择。
- 命令执行在"策略门控 + 人工审批"之外已加应用层加固（cwd 约束 + 环境最小化 + 超时进程树终止）；
  OS 级命名空间隔离仅在 Linux 且检测到 bubblewrap 时启用，其余平台仍非容器/VM 隔离，请谨慎配置命令白名单。
- 断线续跑（`resume` 继续进行中的对话）仍限同一 daemon 进程内；daemon 重启后已在进行的会话无法续跑，需新建会话（历史记录不受影响）。
- Remote-SSH / WSL / Containers 场景尚未在真实环境实测；daemon 仍仅监听 127.0.0.1，跨主机访问需先做 TLS + 鉴权升级。
- 会话历史外置到工作区 `.dsh/history.json`（跨 daemon 重启持久、换机随工作区迁移），仍按工作区分文件隔离。
- **daemon 生命周期与窗口绑定**：daemon 由扩展宿主 `spawn`，在扩展 `deactivate()`（关闭该窗口的扩展宿主 /
  退出 VSCode）时被回收，**不会跨窗口长期存活**。同一工作区的多个窗口可复用同一个 daemon（谁先拉起谁负责回收），
  所有者退出后其他窗口会在下次需要时按 `auto` 重新拉起自己的 daemon；因此"关掉窗口再打开，未完成的会话"
  不会自动续上（daemon 进程已重启），历史记录不受影响。

---

**License**: [MIT](LICENSE) · 详细版本变化见 [CHANGELOG.md](CHANGELOG.md) · 安全策略见 [SECURITY.md](SECURITY.md) · 参与开发见 [CONTRIBUTING.md](CONTRIBUTING.md)
