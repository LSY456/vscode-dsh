# vscode-dsh — 开箱可用的 VSCode 本地 Agent（自带内核，协议可插拔）

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
| 🛡️ **改动可控** | 高危工具调用必须过**审批卡**（Human-in-the-Loop）；文件修改必须先看**原生 Diff 并排视图**再决定落盘——把"AI 盲改"变成"AI 提议、人拍板" |
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
npm test                    # 单元测试（vitest，466 用例）
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
  / **执行迹线**（按需打开的审计面板，按钮上带步骤计数）/ **模型设置**；顶栏同时显示当前会话标题，
  连接状态与当前 Agent 实现显示在输入区下方的状态行。
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
| `dsh.preset` | `default` | 握手时传给 daemon 的 Agent 预设 |
| `dsh.model.baseURL` | `https://api.deepseek.com/v1` | 模型 API 端点 base（OpenAI 兼容） |
| `dsh.model.model` | `deepseek-flash` | 模型名。建议在侧边栏「模型设置」里从下拉选择（列表自动跟随 DeepSeek 官方更新） |
| `dsh.model.idleTimeoutSeconds` | `60` | 模型请求空闲超时秒数（0–1800，0 = 关闭）；距上一个流式增量超时即中断，防会话永久挂起 |
| `dsh.context.gitStatus` | `true` | 附带 git status（失败静默跳过） |
| `dsh.context.maxFileBytes` | `200000` | 附件内联内容阈值；超出改为 `contentOmitted` 按需 `file.read` |
| `dsh.diff.autoOpen` | `true` | 补丁到达时自动打开 Diff 视图 |
| `dsh.history.maxSessions` | `50` | 会话历史保留条数（0–10000，0 = 不限）；超出按创建时间裁剪最旧的 |
| `dsh.capabilities.allowedTools` | `[]` | 工具白名单（空 = 全部允许），如 `["bash_execute"]` |
| `dsh.capabilities.maxConcurrency` | `0` | daemon 全局并发会话上限（0 = 不限） |
| `dsh.approval.ttlSeconds` | `60` | 审批 / 补丁挂起的超时秒数（10–3600，到点按拒绝处理；改后重启 daemon 生效） |

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
│       ├── sessionManager.ts # 会话状态机 + 事件缓冲 + 审批/补丁强校验（纯逻辑，可单测）
│       ├── paths.ts        # 路径护栏（canonical，防 symlink/junction 逃逸）
│       ├── agent.ts        # 模拟 Agent 循环（mock 实现，演示/测试用）
│       ├── realAgent.ts    # 真实 Agent 循环（模型 + 工具 + 审批门控）
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
- **端口**：daemon 仅监听 `127.0.0.1` 随机端口；端口经 stdout/端口文件上报，不暴露公网。
- **一次性 Token**：扩展生成 24 字节随机 token，经环境变量传给 daemon 子进程；WS 打开握手必须
  携带 `Authorization: Bearer <token>`；拒绝任何带浏览器 `Origin` 的连接（防跨站 WebSocket 劫持）。
- **能力分级**：握手时声明 `allowedTools / allowedDirs / maxConcurrency`，越权工具直接禁用
  （不发审批）、越界路径一律拒绝（`-32012`）。
- **路径护栏（canonical）**：patch / `file.read` / 附件读取目标以 `fs.realpathSync` 解析后的
  **规范路径**做包含判断，拒绝 `..` 逃逸、符号链接/目录联结（junction）逃逸、NUL 与 Windows ADS。
- **审批/补丁强校验**：id 归属校验（`-32013`）+ 60s 过期（`-32010`，UI 倒计时置灰）。
- **命令默认拒绝**：`bash_execute` 在内置高危拒绝规则（`rm -rf`、fork bomb、格式化、`curl|sh`、
  shutdown 等）之外，还需人工审批；普通命令亦须审批。
- **密钥脱敏 + 权限**：轨迹持久化前统一脱敏密钥 / Token / 密码词面；轨迹目录 `0700`、文件 `0600`。
- **Webview 隔离**：CSP `default-src 'none'` + nonce 脚本；Webview 无网络权限，仅经扩展中转。
- **补丁落盘护栏**：Agent 修改文件必须经过 Diff 审查；拒绝即不写盘（参考 daemon 在收到
  `file.patch.respond(accept)` 后才写）。

## 工程质量（P0）

- **单元测试**：`npm test`（vitest，466 用例）覆盖协议守卫、路径护栏（含 canonical 防符号链接逃逸）、
  会话状态机（并发/过期/续跑）、Agent 全分支、模型适配（SSE 流式解析，OpenAI 兼容 + Anthropic）、
  工具沙箱（护栏/策略/默认拒绝/命令沙箱）、轨迹持久化（脱敏/缓冲/轮转）、真实 Agent 循环、
  Webview Markdown 渲染与净化（XSS 安全）、以及面板 DOM 契约（jsdom 载入真实 `media/webview.html`）。
- **端到端冒烟**：`npm run smoke` 覆盖安全握手、能力禁用、补丁、审批、多会话并发、断线续跑、
  `file.read` 越界拒绝、真实 Agent 流水线（`--agent real --fake-model`：读/写工具 + 轨迹落盘），
  以及真实 `bash_execute`（审批 → spawn 执行 → cwd 约束校验）。
- **集成测试**：`npm run test:integration` 用 `@vscode/test-electron` 启动真实 VSCode Extension Host，
  覆盖扩展宿主层 ↔ daemon 的完整闭环（T1 激活连接 / T2 补丁 / T3 审批 / T4 路径护栏 / T5 编辑后应用）。
- **协议第二实现冒烟**：`npm run smoke:protocol` 拉起 `examples/python-daemon`（Python 3 + 仅标准库、
  手写 WebSocket）并按协议走完 `initialize → session.create → session.send（含 read_file 工具）→ shutdown`，
  同时断言错 token / 带 `Origin` 的握手被拒、路径护栏生效、错误码正确。它是"后端可换"的**可执行证据**，
  也是任何第三方实现照着跑通即算兼容的**规格样本**（CI 用 `--require` 跑，缺 Python 判失败）。
- **真实连通冒烟**：`npm run smoke:real`（可选，需真实 apiKey，不参与 CI）用真实 endpoint 的 SSE 流
  验证 OpenAI 兼容与 Anthropic 两条适配链解析出非空正文且流式增量触发；缺 key 诚实跳过（退出 0）。
- **CI**：`.github/workflows/ci.yml` 在 push/PR 自动执行 security（npm audit + osv-scanner）、
  typecheck → build → unit → smoke → 协议第二实现（win/ubuntu，显式 setup-python）、
  integration（vscode extension host，ubuntu）；main 分支额外产出 VSIX 构件。
- **日志**：扩展 OutputChannel 分级日志（`dsh.log.level`），daemon stderr 转发。
- **打包**：`npm run package` 产出约 248KB 的 VSIX（`dist/`，38 文件）。

## 迹线（Trajectory）数据映射

daemon 内部轨迹以 **`trajectory.record` 事件流**投影到 VSCode，每条含
`step / kind(reasoning|message|tool|patch|approval|system) / detail / ts`；UI 渲染为可折叠的
"执行迹线"面板，用于审计、回放与失败定位。详见 [PROTOCOL.md §6](PROTOCOL.md#6-迹线trajectory数据映射)。

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

## 路线图

### 已完成
- [x] 协议契约 + 参考 daemon（安全握手/流式/审批/补丁/迹线/取消）
- [x] Extension Host（进程管理/上下文捕获/Diff 提供器/Webview 桥）
- [x] Webview UI（推理流/打字机/工具卡/审批卡/补丁卡/迹线面板）
- [x] **D1-D3 面板重设计**：跟随当前主题的 VSCode 原生观感（`--vscode-*` 变量，浅/深/高对比自适应）、
      工具调用折叠为「过程」时间线、挂起项（审批/补丁）常驻待办条 + 60s 倒计时、滚动锁定与
      Esc/Enter 键盘操作、历史与设置改为覆盖式面板、回答一键复制
- [x] **E1-E4 可用性补齐（P0）**：活动栏常驻视图入口、新建 / 切回历史会话（daemon 重放续聊）、
      补丁 Diff 标题栏的应用 / 编辑后应用 / 拒绝按钮、挂起项超时可配（`dsh.approval.ttlSeconds`）
- [x] **P0 一致性加固**：脏文档一致性（未保存缓冲区优先读取 + 补丁改走编辑器，避免覆盖用户编辑）、
      补丁乐观并发校验（防静默覆盖并发修改）、取消可中断在途模型请求 + 模型请求空闲超时、
      能力/运行时配置与脏文档覆盖层下沉到**连接**作用域（多窗口复用 daemon 互不污染）
- [x] **P0 工程质量**：vitest 单元测试（466 用例）、GitHub Actions CI、OutputChannel 分级日志、VSIX 打包
- [x] **P1 协议加固**：审批/补丁强校验 + 过期同步（`-32010`）、会话状态机 + 事件缓冲 + `session.resume`
      断线续跑、路径护栏（`-32012`）、能力分级（allowedTools/allowedDirs/maxConcurrency）、
      多会话并发（会话级而非连接级）、大文件 `file.read` 按需读取、心跳
- [x] **P3 真实 daemon**：模型适配层（OpenAI 兼容流式 + 思维链分离）、真实 Agent 循环（同一 AgentContext
      契约 + 原生 function calling）、真实工具沙箱（只读搜索 read_file/list_dir/grep/glob、写入 Diff 审查、高危命令策略+审批）、轨迹持久化（JSONL 轮转）、
      按 `dsh.apiKey` 自动切换 mock/real
- [x] **A1 Webview 渲染**：Markdown 渲染（marked + GFM）+ 代码高亮（highlight.js，常用语言）+ DOMPurify
      统一净化（配合 CSP 双层防御 XSS），流式期间纯文本、结束时一次性安全渲染
- [x] **A2 流式渲染批处理**：token 级 delta 按帧节流写 DOM（rAF，无 rAF 退避），消息结束前冲刷兜底，
      长回答不再高频 reflow/抖动
- [x] **A3 会话历史**：extension 侧 workspaceState 持久化（面板重开不丢 + 按工作区隔离）、
      历史会话列表与一键回放、异常中断最后一段回答兜底落库
- [x] **A4 配置面板 + 凭据安全化**：apiKey 迁移 VSCode SecretStorage（旧明文自动回迁并清除）、
      面板化模型配置（API Key / 模型 / BaseURL / 预设），保存后一键重启 daemon 生效
- [x] **P2 信任记忆 + 补丁编辑**：免审批白名单（审批卡「接受并记住」脱敏生成规则、高危程序仅精确匹配、
      工具白名单优先于信任放行、规则落 `.dsh/trust.json` 可审阅清空）、Diff 编辑后应用（补丁左侧自由
      编辑后采纳，`file.patch.respond` 携带编辑后内容写盘）
- [x] **C 系列工程化**：CI 安全扫描（`npm audit --omit=dev` 生产依赖高危阻断 + OSV-Scanner 全量扫描）、
      daemon 日志落盘（tee stdout/stderr 到 `.dsh/logs/daemon.log`，带轮转与 0600 权限）、
      `trajectory.list` 协议化（以协议回放脱敏轨迹，替代直接读 JSONL 文件）
- [x] **集成测试**：`@vscode/test-electron` 启动真实 VSCode Extension Host，自动化 T1-T5
      （激活连接 / 补丁 / 审批 / 路径护栏 / 编辑后应用）
- [x] **P3.5+ 生产化**：命令执行沙箱（可插拔后端：Linux 检测到 bubblewrap 即启用命名空间隔离，
      其余平台应用层兜底 cwd 约束 + 环境最小化 + 超时进程树终止，降级原因显式告警）、模型多点位
      （OpenAI 兼容全家桶 + Anthropic Messages 适配，经 `dsh.model.provider` 选择）
- [x] **B+ 定位收敛**：README 改为「三层定位」（自带内核开箱可用 / 开放协议 + 参考实现 / mock 仅测试夹具）；
      消除未配 Key 时的**静默降级**（daemon 回报 `agentReason`，面板显示「演示模式」横幅 + 模式 chip + 一键配置）；
      新增协议**第二实现** `examples/python-daemon`（Python 3 + 仅标准库）与 `npm run smoke:protocol`，
      把"后端可换"从文档承诺变成可执行断言；mock 关键字教学移出主路径（见 [docs/mock-agent.md](docs/mock-agent.md)）
- [x] **UI 缺陷修复**：`[hidden]` 属性被 `.sheet` / `.pending-bar` 自带的 `display: flex` 覆盖
      （作者样式优先级高于 UA 样式表），导致覆盖式面板与待办条可能常显；补全局 `[hidden]` 兜底规则

### 待办
- [ ] P4a：Remote-SSH / WSL / Containers 场景实测（核心链路已由 CI Linux 拓扑覆盖，待真实环境确认 drvfs 路径 / remote server 环境 / 容器网络等边界）
- [ ] P4b：跨主机 TLS + 鉴权升级（仅当 daemon 需监听非 127.0.0.1 供跨机访问时；标准 Remote 场景 extension 与 daemon 同在 remote 走 localhost，不需要）

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
