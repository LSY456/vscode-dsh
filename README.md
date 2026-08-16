# vscode-dsh — 把 DeepSeek Harness 变成你的 VSCode 本地 Agent 引擎

**vscode-dsh** 是一个将 **DeepSeek Harness（dsh）** 接入 VSCode 的插件：dsh 作为底层的
**Agent Daemon 运行时**（基于 Cordis 元框架），VSCode 插件作为**上下文捕获器与用户交互面板**，
二者通过双向事件流（WebSocket / JSON-RPC）解耦通信。

本仓库是一个**完整可运行**的插件工程：内置一个协议兼容的**参考 daemon**（模拟 Agent 循环），
无需真实模型即可端到端演示全部流程；真实 daemon（Cordis 动态插件版）只需实现同一协议即可无缝替换。

---

## 它能带来什么

| 能力 | 说明 |
| --- | --- |
| 🧠 **Agent 独立成 daemon** | 模型路由、工具调度、会话状态全部下沉到独立进程，与编辑器解耦；长任务不再拖垮编辑器，会话可跨窗口存活，同一 Agent 内核可复用于 CLI / Web / 其他 IDE |
| 📎 **上下文不失真** | 发送 Prompt 时自动打包活动文件全文、高亮选区（带行号）、编译诊断、git status 为结构化附件，不再需要手动复制粘贴、不再丢失编辑现场 |
| 🛡️ **改动可控** | 高危工具调用必须过**审批卡**（Human-in-the-Loop）；文件修改必须先看**原生 Diff 并排视图**再决定落盘——把"AI 盲改"变成"AI 提议、人拍板" |
| 🔒 **安全边界干净** | 工具在独立 daemon 进程执行，仅监听 127.0.0.1 随机端口，WS 握手必须带一次性 Bearer token、拒绝带浏览器 Origin 的连接 |
| 🔌 **协议化可插拔** | 一份明确 JSON-RPC 契约（8 方法 / 13 事件），前端可换（VSCode / JetBrains / CLI），后端可换（参考 daemon / 真实 Cordis daemon），只依赖协议、不依赖实现 |
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
│          dsh Agent Daemon (Cordis / 参考实现)           │
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

# 2. 构建（扩展宿主 + 参考 daemon + webview 静态资源）
npm run build          # 或 npm run watch 增量

# 3. 验证协议闭环（不依赖 VSCode）
npm run smoke          # 覆盖：安全握手/补丁/审批/取消/ping

# 4. 在 VSCode 中按 F5 启动 Extension Development Host
```

启动后：

- 命令面板运行 **`dsh: 打开 Agent 面板`**，状态栏出现 `dsh` 图标（绿点=已连接）。
- 编辑器选中代码后右键 **`dsh: 将选中代码发送给 Agent`**。
- 在面板输入：
  - `请修改文件 xxx 中的 TODO（write edit）` → 自动打开原生 Diff 并排视图，可应用/拒绝；
  - `危险操作：请运行 bash rm -rf（danger）` → 弹出工具审批卡片；
  - `slow 输出测试（slow）` → 可点"取消"验证流式中断。
- 命令 `dsh: 重启 Daemon` / `dsh: 查看 Daemon 状态` / `dsh: 调试 - 打印捕获的上下文`。

## 配置项（settings.json）

| key | 默认 | 说明 |
| --- | --- | --- |
| `dsh.daemon.mode` | `auto` | `auto` 自动拉起 / `external` 连接已有 daemon / `none` 仅 UI |
| `dsh.daemon.command` | `""` | 外部 daemon 启动命令模板（支持 `{portFile} {workspace} {token}` 占位） |
| `dsh.daemon.port` | `0` | `external` 模式端口 |
| `dsh.daemon.token` | `""` | `external` 模式握手令牌 |
| `dsh.apiKey` / `dsh.preset` | `""` / `default` | 握手时传给 daemon |
| `dsh.context.gitStatus` | `true` | 附带 git status（失败静默跳过） |
| `dsh.context.maxFileBytes` | `200000` | 附件内容截断阈值 |
| `dsh.diff.autoOpen` | `true` | 补丁到达时自动打开 Diff 视图 |

## 目录结构

```
vscode-dsh/
├── package.json            # 扩展清单（命令/配置/激活事件）
├── esbuild.js              # 构建：extension + daemon + media
├── shared/protocol.ts      # ★ 协议契约（两端共享，真实 daemon 必须兼容）
├── src/
│   ├── extension.ts        # 入口：命令、状态栏、组装
│   ├── daemonManager.ts    # 进程生命周期：探测/拉起/连接/重连/回收
│   ├── wsClient.ts         # JSON-RPC over WS 客户端
│   ├── contextCapture.ts   # 主动上下文捕获（文件/选区/诊断/git）
│   ├── diffProvider.ts     # 虚拟文档 + vscode.diff + 补丁审批
│   ├── webviewPanel.ts     # Webview 面板宿主与消息桥
│   └── daemon/
│       ├── index.ts        # 参考 daemon CLI 入口
│       ├── server.ts       # WS/JSON-RPC 服务端（安全握手/会话/挂起恢复）
│       └── agent.ts        # 模拟 Agent 循环（演示/测试用）
├── media/                  # Webview 静态资源（HTML/CSS/JS）
├── scripts/smoke.js        # 端到端冒烟测试（无 VSCode 依赖）
├── PROTOCOL.md             # 协议规范
└── .gitignore              # 忽略 node_modules / 构建产物 / 缓存 / 运行时状态等
```

## 安全设计

- **端口**：daemon 仅监听 `127.0.0.1` 随机端口；端口经 stdout/端口文件上报，不暴露公网。
- **一次性 Token**：扩展生成 24 字节随机 token，经环境变量传给 daemon 子进程；WS 打开握手必须
  携带 `Authorization: Bearer <token>`；拒绝任何带浏览器 `Origin` 的连接（防跨站 WebSocket 劫持）。
- **Webview 隔离**：CSP `default-src 'none'` + nonce 脚本；Webview 无网络权限，仅经扩展中转。
- **补丁落盘护栏**：Agent 修改文件必须经过 Diff 审查；拒绝即不写盘（参考 daemon 在收到
  `file.patch.respond(accept)` 后才写）。

## 迹线（Trajectory）数据映射

daemon 内部轨迹以 **`trajectory.record` 事件流**投影到 VSCode，每条含
`step / kind(reasoning|message|tool|patch|approval|system) / detail / ts`；UI 渲染为可折叠的
"执行迹线"面板，用于审计、回放与失败定位。详见 [PROTOCOL.md §6](PROTOCOL.md#6-迹线trajectory数据映射)。

## 接入真实 dsh daemon

参考 daemon（`src/daemon/*`）仅用于演示与测试。接入真实实现有两种方式：

1. **外部进程**：启动真实 daemon 并实现 `DSH_DAEMON_PORT=` 输出与同一协议，配置
   `dsh.daemon.command` 或 `dsh.daemon.mode = external` + `port/token`。
2. **Cordis 动态插件**（推荐方向）：在 dsh 宿主中以 Cordis 插件注册同名方法/事件（模型适配、
   工具沙箱、轨迹存储），监听随机端口；扩展侧无需任何改动。协议细节以 `shared/protocol.ts`
   与 `PROTOCOL.md` 为准。

## 路线图

- [x] 协议契约 + 参考 daemon（安全握手/流式/审批/补丁/迹线/取消）
- [x] Extension Host（进程管理/上下文捕获/Diff 提供器/Webview 桥）
- [x] Webview UI（推理流/打字机/工具卡/审批卡/补丁卡/迹线面板）
- [x] 端到端冒烟测试
- [ ] Cordis 动态插件版真实 daemon（模型调用 + 工具沙箱 + 持久化轨迹）
- [ ] 编辑器事件被动注入（文件切换/保存自动刷新上下文）
- [ ] 多会话管理、会话历史持久化、VSIX 打包发布

## 已知局限

- 参考 daemon 为模拟实现，不含真实模型调用与工具沙箱（用于演示协议）。
- 单连接单会话串行；审批/补丁响应缺少 id 归属强校验与过期状态同步。
- 未覆盖 VSCode Remote-SSH / WSL / Containers 场景（"仅 127.0.0.1"模型需升级为 TLS + 鉴权）。
- 无信任记忆（免审批白名单），高频使用会产生审批疲劳。

---

**License**: MIT（见 `package.json`）。提交到 GitHub 私有仓库前，建议在仓库设置中关闭
"Template repository" 并确认 `LICENSE` 文件按需添加。
