# vscode-dsh 项目评估与优化方案

> 评估对象：`vscode-dsh` v0.4.0（VSCode 插件 + 本地 Agent Daemon）
> 评估时间：2026-09-21
> 评估方法：全量源码阅读（`shared/` `src/` `media/` `scripts/` `.github/` 共 40+ 文件）+ 本地实跑 `npm run typecheck` 与 `npm test`
> 结论口径：所有"事实"均给出文件与行号；带【判断】标记的为分析性推论，建议复核后再决策。
>
> **❗ 阅读前必看（2026-09-22 追记）**：本报告的 **战略判断 1「真实 Agent 内核仍缺席」已被复核推翻**。
> 仓库里其实有完整内核 `src/daemon/realAgent.ts`（原生 function calling、工具沙箱、审批门控、
> Diff 审查、token 预算、可中断请求），`resolveAgentMode()` 在 `auto` 下**配好 Key 就走它**；
> 真正缺的是**仓库外的 Cordis 版 daemon**。该结论与据此的取舍见
> [docs/strategy-agent-kernel.md](strategy-agent-kernel.md)（已采纳方案 B+）。
> 本报告中的**实测数字**（用例数、耗时）是评估当日的快照，未随代码演进更新；
> 涉及定位/路线的结论请以 strategy 文档为准，涉及具体缺口的结论仍然有效。

---

## 0. 一句话结论

**这是一个架构判断正确、安全工程超出同类的"协议参考实现"，但产品化的关键一环（真实 Agent 内核）仍缺席，且存在若干会导致"改错文件"的正确性缺陷。**

- 工程骨架完成度约 **85%**（协议、daemon、扩展宿主、UI、CI、测试全部自洽可跑）；
- 产品竞争力完成度约 **40%**（仍以关键字驱动的 mock Agent 为主体，缺图片输入、缺事务回滚；**MCP 已于 2026-10-01 明确不做，见 §4「MCP 追记」**）；**【2026-10-09 追记：图片输入（P2-4）与会话回滚（P2-6）均已实现、Plan 模式（P2-7）已实现待合并，见 §4 各追记】**；
- 存在 **4 个 P0 级正确性/安全问题**，其中"未保存缓冲区 vs 磁盘不一致"会在真实使用中直接造成用户代码被覆盖，属于必须优先修的类别。

---

## 1. 项目定位与目标

### 1.1 它是什么

把 **DeepSeek Harness（dsh）** 接入 VSCode 的双进程架构插件：

| 角色 | 承担者 | 职责 |
| --- | --- | --- |
| 传感器 + 遥控器 | VSCode 扩展宿主 + Webview | 捕获编辑现场、渲染流式输出、审批、Diff 审查 |
| 大脑 | 独立 daemon 进程 | 模型路由、工具调度、会话状态、轨迹持久化 |
| 契约 | `shared/protocol.ts` + `PROTOCOL.md` | JSON-RPC 2.0 over WebSocket，两端各自演进 |

### 1.2 设计目标（从代码与文档反推）

1. **Agent 内核与编辑器解耦** —— 反对 Cline/Roo 式的"Agent 逻辑写进扩展宿主"。
2. **上下文零损耗** —— 自动打包活动文件 / 选区 / 诊断 / git 状态，免手工复制粘贴。
3. **AI 只提议、人拍板** —— 高危工具走审批卡，文件改动先看原生 Diff 再落盘。
4. **安全边界干净** —— 工具在独立进程执行，127.0.0.1 + 一次性 token + Origin 拒绝。
5. **协议化可插拔** —— 前端可换（VSCode/JetBrains/CLI），后端可换（mock/真实模型/Cordis 插件）。

【判断】这五条里，(1)(2)(3) 是真差异化护城河；(4) 是及格线要求；(5) 目前只有"文档承诺"，缺少除本仓库之外的第二实现来证明协议确实可插拔。

### 1.3 目标用户与典型场景

- 需要在编辑器内让模型"看得见我的现场、改得动我的文件"的开发者；
- 对"AI 盲改代码"零容忍、要求逐次审查的团队；
- 想自己接模型/自建 Agent 内核、但不想重写前端交互的技术团队。

### 1.4 项目真实形态【判断，但证据充分】

仓库同时是三种东西，权重依次递减：

1. **协议参考实现**（权重最高）—— `PROTOCOL.md` + `shared/protocol.ts` + 参考 daemon，设计意图明显是"给真实 dsh 提供一份可对照的样板"。
2. **可运行的 VSCode 插件**（权重中）—— 端到端能跑，配合 `dsh.apiKey` 可调真实模型。
3. **演示工程**（体现在 mock agent）—— `agent.ts:112-223` 用 `prompt` 关键字（`/修改|edit|write/`、`/bash|danger/`、`/slow|慢/`）驱动行为；`README.md:117-119` 直接教用户输入 `（write edit）`、`（danger）`、`（slow）` 这类"咒语"。

**这条落差是本项目最重要的战略事实**：README 通篇假设"真实 daemon（Cordis 动态插件版）只需实现同一协议即可无缝替换"（`README.md:13`），但该实现不在本仓库。当前用户拿到的实际体验，是关键字驱动的模拟 Agent。

---

## 2. 架构与实现盘点

### 2.1 模块清单

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 契约 | `shared/protocol.ts` | JSON-RPC 方法/事件/错误码/附件类型；两端共享 |
| 扩展宿主 | `src/extension.ts` | 入口装配、命令、状态栏 |
| | `src/daemonManager.ts` | daemon 探测/拉起/握手/心跳/重连/陈旧回收 |
| | `src/wsClient.ts` | WS JSON-RPC 客户端（id 映射、心跳、错误码透传） |
| | `src/contextCapture.ts` | 活动文件/选区/诊断/git 打包 |
| | `src/diffProvider.ts` | `dsh-patch` 虚拟 FS + `vscode.diff` + 补丁决策 |
| | `src/webviewPanel.ts` | 双 surface 宿主（侧边栏 View + 编辑器 Panel）、消息桥、历史落库 |
| | `src/sessionHistory.ts` | `.dsh/history.json` 持久化（异步串行写 + 内存缓存） |
| | `src/configAccessor.ts` | apiKey SecretStorage 化 + 旧明文回迁 |
| daemon | `src/daemon/server.ts` | WS/JSON-RPC 服务端、安全握手、能力分级、resume |
| | `src/daemon/sessionManager.ts` | 会话状态机 + 2000 条事件环形缓冲 + 挂起强校验 |
| | `src/daemon/realAgent.ts` | 真实 Agent 循环（原生 function calling + fenced 兜底） |
| | `src/daemon/agent.ts` | mock Agent 循环（关键字驱动） |
| | `src/daemon/model.ts` | OpenAI 兼容 / Anthropic SSE 适配 + Fake 模型 |
| | `src/daemon/tools.ts` | 工具沙箱（read/list/grep/glob/write/patch/bash）+ 命令策略 |
| | `src/daemon/paths.ts` | canonical 路径护栏（realpath + ADS/NUL 拒绝） |
| | `src/daemon/sandbox.ts` | bwrap / ProcessSandbox 可插拔后端 |
| | `src/daemon/trust.ts` | 免审批白名单（脱敏 + 高危程序仅 exact） |
| | `src/daemon/trajectoryStore.ts` | JSONL 轨迹（脱敏 + 缓冲 + 轮转） |
| | `src/daemon/logFile.ts` | stdout/stderr tee 落盘 |
| UI | `media/webview.js` (1155 行) | 事件渲染、审批卡、补丁卡、迹线、待办条 |
| | `media/webview.css` (1053 行) | 全 `--vscode-*` 变量，主题自适应 |

### 2.2 关键数据流

```
Webview ──postMessage──> WebviewPanelHost ──JSON-RPC/WS──> Daemon server
   ↑                          │                                │
   └──event/status/init───────┘                    realAgent/mockAgent
                                                            │
                              file.patch.pending ──> DshDiffManager (dsh-patch FS)
                                                            │
                              tools.ts ← paths.ts 护栏 ←───┘
```

---

## 3. 优点：做对了什么

### 3.1 架构：三个正确且少见的决策

1. **Webview 不直连 daemon**（`README.md:68`）。WS 只存在于 Extension Host ↔ daemon，Webview 经 `postMessage` 中转。这消除了"被 Webview 攻击面直接拿到 daemon 令牌"的路径，比同类插件干净。
2. **补丁走虚拟文件系统而非直接写盘**（`diffProvider.ts:36-73`）。且 `isReadonly: false`（`diffProvider.ts:51-54`）—— 注释里明确记录了曾经的踩坑：`TextDocumentContentProvider` 会让右侧变成只读，导致"编辑后应用"退化成只能看。这是很扎实的经验沉淀。
3. **陈旧 daemon 防护**（`esbuild.js:41-47` + `daemonManager.ts:229-237`）。每次构建写随机 `buildId`，握手比对不一致即回收旧进程。绝大多数插件工程不会想到这一层，而它对应的是真实事故（升级后连上旧进程、修复不生效）。

### 3.2 安全：超出同类的细度

- **canonical 路径护栏**（`paths.ts:86-97`）—— 不是词法比对，而是 `realpathSync` 解析后判定，显式拒绝 symlink/junction 逃逸、`..`、NUL、Windows ADS（`paths.ts:48-61`）。`tools.ts:113-134` 的 `walkFiles` 也在进入每个目录前重做 canonical 校验，防止搜索跟随链接出界。
- **命令默认拒绝是并集而非配置**（`tools.ts:247-291`）—— `DEFAULT_DENY_PATTERNS` 无论用户怎么配都生效，用户策略只能在其之上叠加。
- **信任白名单的分级设计**（`trust.ts:31-77`）—— 脱敏为"程序 + 首个参数"，高危程序（`rm/dd/mkfs/...`）禁止生成宽松前缀规则，只允许整条精确匹配；边界匹配用 `pattern + ' '` 避免 `npm run` 命中 `npm runall`。
- **诚实披露残余风险**（`SECURITY.md:30-39`）—— 明确写了"非全平台 OS 级沙箱"、"回环内明文传输 apiKey"、"同用户进程可读环境变量"。这种不粉饰的写法值得肯定。

### 3.3 工程质量：实测基线扎实

本地实跑结果：

```
npm run typecheck  → 通过，零错误
npm test           → 18 个测试文件 / 244 个用例 全部通过，耗时 27.57s（2026-09-21 快照；截至 2026-09-22 为 21 文件 / 317 用例）
```

- daemon 侧关键模块**全部可单测**（`paths/tools/model/toolcall/sessionManager/trust/sandbox/trajectoryStore/realAgent`），且 `vitest run --pool=threads` 并行。
- Webview 的 Markdown 渲染做了 **DOMPurify + CSP 双层 XSS 防御**，并有独立测试（`src/webview/render.test.js`，17 例）。
- 构建产物 `out/extension.js`、`out/daemon/index.js` 齐全，`esbuild.js` 一次构建三个 target（node 扩展 / node daemon / browser webview）。

---

## 4. 缺点与风险

### P0 —— 正确性 / 安全，建议立即修

#### P0-1　未保存缓冲区与磁盘内容不一致 → 会覆盖用户未保存的编辑

**现状**（事实）：
- 附件内容取自编辑器缓冲区：`contextCapture.ts:33` `const text = doc.getText()`（含未保存编辑）。
- 工具读文件取自磁盘：`tools.ts:61-71` `readTextFile` → `fs.readFileSync`。
- 补丁写盘也直接写磁盘：`tools.ts:215-219` `writeTextFile`。

**影响**：用户改了文件但没 Ctrl+S，然后让 Agent"优化这个函数"。模型在附件里看到的是**新代码**，而 `read_file` 返回的是**旧代码**；两者矛盾时模型可能按旧代码生成补丁，用户点"应用"后 → 磁盘被旧逻辑覆盖，编辑器里的未保存编辑被静默丢弃。

**建议**：
1. 在扩展侧为 `file.read` 增加"脏文档分支"：`workspace.textDocuments` 里若存在同路径且 `isDirty` 的文档，返回缓冲区内容而非磁盘内容（在 `server.ts:442-462` 的 `FileRead` 里加一个由扩展声明的 `useBuffer` 能力位，或让扩展随附件一并下发 dirty 文档快照）。
2. `write_file` / `apply_patch` 落盘前，若目标在编辑器中是脏文档，改为经 VSCode 的 `WorkspaceEdit` 应用，让编辑器正确合并/提示冲突，而不是直接 `fs.writeFileSync`。

#### P0-2　补丁缺少乐观并发校验（TOCTOU）→ 静默覆盖他人改动

**现状**（事实）：`realAgent.ts:320-357` 在 `file.patch.pending` 时快照 `oldContent`，`file.patch.respond(accept)` 到达后直接 `writeTextFile(...)`，**不再校验磁盘当前内容是否仍等于 `oldContent`**。

**影响**：Agent 提议修改 → 用户去看 Diff → 同时自己或另一个工具改了同一文件 → 点应用 → 先前改动被无声抹掉。生产级代码审查工具必备的乐观锁在这里缺失。

**建议**：落盘前重读磁盘内容与 `oldContent` 比对，不一致则回 `file.patch.result { applied: false, error: '文件在审查期间被修改，请重新审查' }`，并在 UI 上给出"重新生成补丁"的路径。

#### P0-3　`session.cancel` 无法中断进行中的模型请求 → 会话可能永久挂起

**现状**（事实）：
- `realAgent.ts:160` 创建 `AbortController`，但**只有** `onChunk` 回调内部会 `abort.abort()`（`realAgent.ts:196-200`）。
- 若模型请求发出后**迟迟没有 chunk 到达**，`onChunk` 永不触发 → `abort` 永不触发 → `ctx.isCanceled()` 只在轮次边界检查（`realAgent.ts:179`）→ 用户点"停止"无效。
- 且 `model.ts:91-105` 的 `fetch` **没有超时**，只接受外部 `signal`。

**影响**：网络抖动 / 端点无响应时，对话卡死在"停止"按钮点了没反应，只能重启 daemon。而 daemon 重启后该会话不可 resume（`PROTOCOL.md:125`），上下文全丢。

**建议**：把 `abort` 的触发权交回 `AgentContext`（例如 `ctx.onCancel(cb)` 或 `cancelSignals`），在 `Session.cancel()` 时直接 abort；同时给模型请求加"首字节超时 + 空闲超时"（例如 30s 无增量即中断并报错）。

#### P0-4　能力与运行时配置是 daemon 实例级，会被多窗口互相污染

**现状**（事实）：`server.ts:79-94` 的 `capabilities`、`approvalTtlMs`、`runtime` 定义在**服务实例**作用域；`server.ts:221-238` 的 `initialize` 直接整体覆写，注释也自认"参考实现为实例级"。

**影响**：同一个 daemon 被多个 VSCode 窗口复用（`daemonManager.ts:294-305` 的 auto 探测会复用同工作区的 `.dsh/daemon.json`）时，**最后一个 initialize 的窗口会覆盖所有人**：A 窗口精心配置的 `allowedTools: []`（全禁用）可能被 B 窗口的空配置冲掉，反过来也一样；`runtime.apiKey`、`model.provider` 同样被覆盖。安全语义被跨窗口污染，且用户完全无感。

**建议**：把 `capabilities` / `runtime` / `approvalTtlMs` 从实例级下沉到 `Connection`（或 `Session`，因为 `session.send` 时会 `attach()` 到具体连接）。若确实需要"实例级默认 + 连接级覆盖"，也应在协议层显式声明并加告警。

---

### P1 —— 健壮性 / 可维护性

| 编号 | 现状（证据） | 影响 | 建议 |
| --- | --- | --- | --- |
| P1-1 | `SessionManager` 只提供 `delete`，server 从不调用（`sessionManager.ts:285-313`）；每个 `Session` 常驻 ≤2000 条事件缓冲 + `patchContent` | daemon 跨天长跑时内存单调增长 | 加 TTL/LRU 回收 + `session.ended` 后延迟清理（保留一个 resume 窗口，如 10 分钟） |
| P1-2 | `grep/glob` 的 `walkFiles` 是**同步递归**（`tools.ts:113-134`），无深度/条目/时间上限，且**无 visited 去重** | 大仓库上阻塞 daemon 事件循环 → 心跳 ping 超时（`wsClient.ts:171-196`，3 次失败即强制重连）→ 用户看到"连接断开"；工作区内的 symlink 环可无限递归 | 改异步遍历 + 深度/条目/时间预算上限 + 按 realpath 去重 visited + 并发限流 |
| P1-3 | `provider=anthropic` 时 baseURL 被 DeepSeek 默认值污染：`package.json:178-182` 默认 `https://api.deepseek.com/v1` → `daemonManager.ts:176-180` 无条件下发 → `model.ts:122-124` 仅在 baseURL 为空时才用官方默认 | 用户只把 provider 切成 anthropic、不改 baseURL → 请求打到 `https://api.deepseek.com/v1/v1/messages`，报 404，且报错信息难定位 | daemon 侧按 provider 决定默认 baseURL；或在 provider 与 baseURL 明显不匹配时给出显式 UI 告警 |
| P1-4 | `spawnExternal` 用 `cmd.split(/\s+/)` 拆命令，且 `String.replace` 不带 `g` 只替换首次（`daemonManager.ts:386-394`） | `dsh.daemon.command` 里带引号的路径/参数必坏；含多个 `{token}` 占位只替换一个 | 改用 `shell-quote`/`string-argv` 解析，或要求配置为数组；`replaceAll` |
| P1-5 | `recycleStaleDaemon` 直接 `process.kill(pid)`（`daemonManager.ts:451-478`），pid 来源是可被任意本地进程写入的 `.dsh/daemon.json` | pid 复用 + 文件被篡改 → 可能误杀无关进程 | kill 前校验目标进程命令行含本 daemon 脚本路径（POSIX 读 `/proc/<pid>/cmdline`，Windows 用 CIM/WMI 查 CommandLine） |
| P1-6 | daemon 的 HTTP 端点无鉴权，任意 GET 都返回 200 + banner（`server.ts:114-117`） | 可被本机任意进程用于端口探测确认 | 非升级请求直接 426/404；或校验 token |
| P1-7 | 过期挂起项只标记 `expired = true` 保留在 Map 中（`sessionManager.ts:237-246`），依赖 `end()` 才清理 | 长 idle 会话中过期项累积（轻微泄漏） | 过期后延迟 60s 清理（既保留 `respond` 返回 `-32010` 的语义，也回收内存） |
| P1-8 | `stepCounter` 是模块级全局（`agent.ts:53`、`realAgent.ts:51`） | `PROTOCOL.md:135` 定义 `step` 为"会话内单调递增"，实际是全局递增；多会话并发时 UI 迹线的步骤号跳跃、不连续 | 计数器挂到 `Session` |
| P1-9 | `docs` 类漂移：`SECURITY.md:7-8` 写支持 `0.3.x/0.2.x`，而 `package.json:5` 是 `0.4.0`；`CONTRIBUTING.md:28` 硬编码"244 用例" | 文档与代码不一致，削弱可信度；用例数会持续漂移 | 版本从 `shared/version.ts` 注入文档；用例数改为脚本生成或直接删除数字 |
| P1-10 | `tsconfig.json:17` 只 include `src/**/*.ts`、`shared/**/*.ts`；`allowJs` 未开 | `media/webview.js`(1155 行)、`src/webview/*.js`、`scripts/*.js`、`esbuild.js` **全部在类型检查之外**，且仓库无 ESLint/vitest 配置文件 | 单独加 `tsconfig.web.json`（`allowJs + checkJs`）覆盖前端与脚本；引入 ESLint + Prettier 并接入 CI |
| P1-11 | ~~CI 硬化缺口（`.github/workflows/ci.yml`）：action 仅用 tag 未 pin SHA（L13/15/27）；无 `permissions:`；无 `concurrency`；无 `timeout-minutes`；无 lint 步骤；integration 每次重下 stable VSCode 无缓存（L78）；OSV 无 SARIF 上报~~ | 原判风险：供应链风险 + 卡死可跑满 6h + 反馈慢。**【2026-10-11 追记：已实现，口径见本节末尾「CI 硬化追记」。唯一没做的是 lint 步骤 —— 仓库至今没有 linter（属 P1-10），不该在这一批里顺手引入** | 已实施：pin SHA、顶层最小权限 + job 级提权、`concurrency`（仅 PR 取消在跑）、逐 job `timeout-minutes`、缓存 `.vscode-test`、OSV 改官方可复用工作流（含 SARIF 上报），并新增工作流守卫把它们锁住 |
| P1-12 | Webview 巨石单文件 + 无类型（`media/webview.js` 1155 行承载事件分发/审批/补丁/历史/设置） | 修改成本高、回归风险大 | 拆为 `events/approvals/patches/history/settings/composer` 模块（浏览器端 ESM 原生支持，esbuild 会合并） |
| P1-13 | `handleEvent` 无 try/catch（`media/webview.js:1020-1026` 附近），默认分支静默吞未知事件 | 单条事件抛错即静默丢失，协议漂移被掩盖成"UI 没反应" | 包 try/catch + 上报到扩展 logger；未知事件在 debug 级别打点 |
| P1-14 | `resetTurn()` 不重置 `answerEl/answerBody/answerBatcher`（`media/webview.js:414-421`），而 `clearMessages()` 才做（L816-844） | **窗口期**：若上一轮既没收到 `message.done` 也没收到 `session.ended`（daemon 流式中崩溃、事件丢失），下一轮 `ensureAnswer()` early-return（L270），新回答续写进旧气泡 | `resetTurn()` 首行调用 `finishAssistant()`（幂等），或在 `user.message` 分支统一走 `finishAssistant()` |
| P1-15 | `.dsh` 各子目录创建权限不统一：`trajectory` 0700（`trajectoryStore.ts:76`）、`logs` 0700（`logFile.ts:52`）、`trust.json` 直接写（`trust.ts:109-117`）、`history.json` 0700（`history.json` 写入路径 `sessionHistory.ts:44`） | `.dsh` 目录本身可能以默认 umask 创建，权限语义不一致 | 统一 `ensureDshDir()` 以 0700 创建 `.dsh` 及各子目录 |
| P1-16 | `getWorkspaceRoot()` 只取 `workspaceFolders[0]`（`daemonManager.ts:480-486`） | 多根工作区语义模糊，`.dsh/` 落在第一个文件夹 | 显式声明"仅支持单根"，或按文件夹起独立 daemon 与独立端口文件 |
| P1-17 | 单测覆盖空白：`server.ts`、`daemonManager.ts`、`wsClient.ts`、`diffProvider.ts`、`contextCapture.ts`、`extension.ts`、`logger.ts` 均无单测 | **`server.ts` 是安全边界（握手/Origin/能力分级/错误码映射）却只靠 smoke 间接覆盖**，是最危险的空白 | 抽出纯函数（`verifyClient` 判定、能力收敛、路径解析、错误码映射）并补单测；`wsClient` 可用本地 `ws` server 做真实连接测试 |
| P1-18 | `agent.test.ts` 依赖真实 `sleep`（`agent.ts:87` 等），13 个用例耗时 **14.3s**，占全套 27.6s 的一半 | 测试套慢 → 反馈慢 | 注入可控时钟/假定时器（vitest `vi.useFakeTimers`），把 `sleep` 变为可注入依赖 |

### P2 —— 体验 / 打磨 / 战略

| 编号 | 现状 | 建议 |
| --- | --- | --- |
| P2-1 | `applyTokenBudget` 整轮丢弃最旧工具轮次（`realAgent.ts:558-569`），早期关键上下文（如接口定义）会凭空消失 | 改为"滑动窗口 + 早期摘要"；工具结果单独设长度上限并做摘要压缩 |
| P2-2 | `maxToolRounds`(8) / `maxContextTokens`(48K) / `maxReadBytes` 硬编码，未进 `package.json` 配置 | 暴露为配置项，并在 UI 展示当前预算占用 |
| P2-3 | `OpenAICompatibleModel` 硬编码 `temperature: 0.2`（`model.ts:282`）；Anthropic 硬编码 `max_tokens: 4096`（`model.ts:326`） | 提为配置；对 reasoning 类模型（`deepseek-reasoner`）跳过 temperature |
| P2-4 | ~~无图片/截图输入能力（`Attachment.kind` 只有 file/selection/diagnostics/gitStatus/text，`protocol.ts:177-202`）~~ | 原建议：补 `image` 附件类型 + 多模态消息体（OpenAI `image_url` / Anthropic `image` block）。**【2026-10-09 追记：已实现，口径见本节末尾「图片输入追记」】** |
| P2-5 | ~~**无 MCP 客户端支持**~~ | 原建议：现代编码 Agent（Cline/Roo/Continue/Copilot）普遍支持 MCP Server，生态无法复用是产品短板，建议把 MCP 客户端放在 daemon 侧。**【2026-10-01 追记：已决策不接入 MCP，理由见本节末尾「MCP 追记」】** |
| P2-6 | ~~无会话级事务回滚（只有单补丁 accept/reject）~~ | 原建议：会话开始时建立影子快照（git stash / 复制到 `.dsh/snapshots/`），提供"回滚本次会话的全部改动"。**【2026-10-08 追记：已实现，口径见本节末尾「会话回滚追记」】** |
| P2-7 | ~~无 plan 模式~~ / 无 subagent / 无显式上下文压缩策略 | 原建议：至少补 plan（先出方案、批准后执行）——与现有审批基础设施天然契合。**【2026-10-09 追记：plan 已实现，口径见本节末尾「Plan 模式追记」；subagent 与显式上下文压缩仍未做】** |
| P2-8 | 可观测性弱：`trajectory` 只有文本 `detail`，无结构化字段（工具、耗时、错误分类、token 用量） | 轨迹记录改为结构化 schema，便于统计"哪类工具最容易失败""单会话 token 成本" |
| P2-9 | 审批风险等级硬编码 `risk: 'high'`（`realAgent.ts:395`） | 按命令类型分级（读/写/网络/删除），让 UI 能差异化呈现 |
| P2-10 | `dist/` 里只有 `vscode-dsh-0.2.1.vsix`（约 390KB，Aug 23），落后于 0.4.0 源码 | 重新打包并清理陈旧产物 **【2026-10-01 追记：已随发行自然解决，`dist/` 现为 0.7.0 / 0.8.0】** |

#### MCP 追记（2026-10-01）

**已决策：本项目不接入 MCP。** 本追记与 §5 阶段 3 第 2 条、§6 优先级矩阵中「MCP 客户端」一行
同属一个决定 —— 三处均以本条为准，后续阅读时不必再把 MCP 当作待办。

**理由（两条，按重要性排序）**

1. **本项目的形态决定了 MCP 边际收益低。** 它是**工作区内的编码 agent**，不是没有 shell 的聊天壳子：
   `bash_execute`（带审批）已经能触达本机可达的目标系统。"让 agent 查询数据库、读日志文件"这两个
   最常被举的例子，用 `psql` / `sqlite3` / `grep` 就能做 —— 而且 P2-5 原文举的正是这两个例子，
   它们恰恰是 MCP 收益最低的一类。
2. **MCP 会绕开本项目已有的三道门。** `assertPathInside` 路径沙箱、`DEFAULT_DENY_PATTERNS` 命令策略、
   审批 + 补丁审查，是 `SECURITY.md` 的全部立论基础；而 MCP server 是用户配置的任意进程/端点，
   **自己决定权限边界，daemon 无法裁决**。接入它的真实代价不是那几百行代码，而是"安全叙事从强变弱"。

**MCP 真正不可替代的场景（将来出现任一条再重新评估）**

- 目标系统 **shell 不可达**：SaaS、内部 API、需要 OAuth / 令牌刷新的受管云服务；
- **"每条只读查询都要点审批"成为真实痛点**（`bash_execute` 无法声明"这次是只读"，而 MCP 的
  `readOnlyHint` 可以，理论上是本项目目前唯一缺失的、有实际价值的能力）；
- 需要**凭据不进模型上下文**（MCP server 内部持有凭据）。

**若将来要做，三条不可退让的前提**（详细方案已在 2026-10-01 的会话中给出，未落档）：
配置只放 **machine 作用域**（绝不进工作区 `settings.json`，否则打开恶意仓库即自动 spawn）、
**每 server+tool 首用必审**（`readOnlyHint` 只作降级参考，不信任 server 的自我声明）、
**受限模式下绝不启动**（复用现有工作区信任门禁）。

#### 会话回滚追记（2026-10-08）

**已实现：`session.rollback` + `dsh: 回滚本次会话的文件改动`。** 两条与原建议不同的取舍，记下来免得日后被"改回去"：

1. **不是"会话开始时建立快照"，而是"每个文件第一次被写入之前"建快照（首写优先）。**
   原文建议的 `git stash` / 复制整个工作区，在会话开始时**根本不知道会动哪些文件** —— 全量复制一个仓库
   既慢又占空间，还会把一堆无关文件卷进来。懒惰快照恰好只覆盖"被改过的那些"，一份不多一份不少；
   而"首写优先"保证回滚目标是**这次会话开始前**而不是"上一次修改前"。
2. **不做"自动回滚 / 影子目录里 diff"，只做显式还原。** 回滚是破坏性操作，入口放在命令面板与面板标题栏，
   执行前有模态确认；目标文件此刻在编辑器里有未保存改动时**跳过而不覆盖**（与补丁落地的安全默认同源）。

代价（诚实记录）：**脏文档跳过意味着"回滚"在这些文件上是不完整的**，用户需要先保存或放弃改动再回滚；
报告里会明确列出这一类（`skippedDirty`），不静默通过。快照**只增不改**，`.dsh/snapshots/` 需用户自行清理。

**2026-10-09 加固（同节修订）**：上线后的代码审视发现上面两条取舍里藏着两个缺陷，已修：

1. **"脏文档跳过"挡不住"改完又保存" —— 静默丢数据。** 用户手工编辑并**保存**之后文件不脏，守卫失效，
   回滚会把他的改动连同 Agent 的一起退回，而报告显示"全部成功"。现改为在每次写入后记录**写入内容的
   sha256**（改动前内容仍首写优先，指纹反过来取**最后一次**写入），还原前读磁盘比对，不一致即归入新增的
   `changedAfter` 类**跳过不覆盖**；没有指纹的旧索引 / 老 daemon 退化为仅按脏文档判定，不让回滚整体失效。
   这与补丁链路上的乐观锁（`checkPatchConflict`）是同一条纪律，只是换了个时间点 —— 本项目对"别静默覆盖
   用户的东西"只有一个标准，回滚当初漏了。
2. **`restore()` 校验了 `entry.path` 却漏了 `entry.blob`。** 两者同源于本机任意进程可写的 `index.json`，
   篡改 `blob` 即可让 daemon 读到快照目录之外的文件 —— 与本模块自述的第 ④ 条不变式自相矛盾。现按白名单
   形状（`blob_NNNN.snap`）校验。

另修：`SessionSnapshotStore.count()` 的注释谎称"面板据此决定是否显示回滚入口"（实际只有 `clear()` 在用，
入口恒显），已改为如实描述。

#### Plan 模式追记（2026-10-09）

**已实现：`session.send { planMode: true }` + 输入框「计划」开关。** 原建议只说"与现有审批基础设施天然契合"，
实际落地时有四处必须自己拍板的取舍，记下来免得日后被当成"过度设计"简化掉：

1. **只读承诺落在工具清单层，不落在提示词层。** 调研阶段提供给模型的工具**只有**
   `read_file` / `list_dir` / `grep` / `glob` —— 写入类工具根本没有出现在 `tools` 参数里。
   在 system 里写一句"请不要修改文件"是**请求**，拿掉工具定义才是**约束**；这个功能的全部说服力
   就建立在"批准前不可能有改动"上，所以它不能是一条靠模型自觉遵守的规则。
   白名单与提示词同放 `src/daemon/planMode.ts`：两者的自洽程度是这一节最该被一眼看清的东西。

2. **调研预算与执行预算分开计数**（`DEFAULT_PLAN_MAX_ROUNDS` = 4，不吃 `maxToolRounds`）。
   共用一份是最省事的写法，但它的激励是反的：计划阶段读得越仔细、批准后可用轮次越少，
   用户实际体验是"批准完直接没轮次了"。预算分配本身就是产品决策。

3. **批准后保留调研期工具结果。** 回注的只有"已批准的计划"与用户补充意见；调研读到的文件内容**不回滚**。
   丢掉它等于让执行阶段把同一批文件再读一遍，还可能出现"计划里写的路径"与"执行时读到的内容"不是同一份。

4. **拒绝与"没产出"都不许静默。** 用户不批准 → `reason: 'canceled'` + 明说「没有改动任何文件」；
   模型没给出可用计划 → 一条明确提示 + `reason: 'error'`。两者都不能报 `completed`
   —— 那正是这个功能要消除的错觉（"它说完成了，所以我以为它改了/它做完了"）。

**复用而非新建**：挂起—恢复用的是既有那套（`waitForUser` / `expiresAt` / 断线续跑 / 取消时一并解除），
因此**没有第二套等待语义**；`session.resume` 一并回传 `pendingPlan`，重开面板或重连后计划卡照常恢复。

**途中修掉一个真实缺陷**：`Session.cancel()` 原先只清审批与补丁快照，**计划快照会残留**——
续跑时 UI 会拿到一张永远无法回答的卡片（其 promise 早已按拒绝解析）。现三个快照一并清除。

**代价（诚实记录）**：计划卡里的文件路径只是模型的自述，**没有做"路径是否在工作区内"的预校验** ——
真正的护栏仍在执行阶段的 `assertPathInside`（批准本身不等于放行越界路径）。另：计划模式**不能与
"只读工具白名单"以外的能力约束叠加**（`capabilities.allowedTools` 更窄时以更窄者为准，两者取交集）。


#### 图片输入追记（2026-10-09）

**已实现：`kind: 'image'` 附件 + 面板粘贴/拖放/选择文件三条入口。** 原文只说"补多模态消息体"，落地时定了三条口径：

1. **图片走独立内容块，文本侧只留位置标记。** 把 base64 折进 `<file>` 一类文本里，模型看到的是几百万字符的
   噪声；而现在文本侧只留 `[图片 N：名字]`，多张时模型知道"第 2 张"指哪一张。这与本项目既有的做法同源 ——
   上层只认一种表示，provider 差异（OpenAI `image_url` / Anthropic `source.base64`）收敛在各自的序列化函数里，
   和 `toolCalls` 的处理方式一样。
2. **校验做两遍。** 扩展侧校验是为了即时反馈（面板上删掉那张就能重发），daemon 侧校验是因为**它才是安全边界**
   （协议允许任意客户端接入，`examples/python-daemon` 就是活证据）。两处共用 `shared/imageAttachment.ts` 这一份
   纯函数，不共用的是"什么时候失败"的语义。
3. **整条拒绝，而不是丢掉那一张。** 原文没提这条，但它决定了这个功能的可用性：这类消息里的图片通常就是提问本身，
   静默少发一张 → 模型对着一张不存在的图作答 → 用户拿到一段看起来完全正常的胡话。拒绝时**不发 `session.started`**，
   模型一次都不会被调用。

代价（诚实记录）：图片**没有**文件路径，字节全程只在消息里 —— 好处是天然不存在 `file`/`selection` 那类路径逃逸面，
攻击面只剩"体积"与"格式"；代价是同一张图在会话历史里也会以 base64 形式留存（体积随之放大），大图因此先缩到长边 1568px。

**没做**：图片的保存/落盘（截图仍只存在于会话消息中）、GIF 压缩（一缩就丢动画）、按像素精确估算 token
（daemon 手里只有 base64，取尺寸要解 PNG/JPEG 头，为一次估算引入半个图片解析器不划算，改取保守常量）。

#### CI 硬化追记（2026-10-11）

**已实现：pin SHA / 最小权限 / 并发 / 超时 / 缓存 / SARIF 上报，并新增一条把上述约束锁住的守卫。** 原文把七件事并列，落地时最大的发现不在清单里：

1. **`uses: google/osv-scanner-action@v1` 指向的 ref 已经不存在了。** 该仓库后来把 `v1` 整个删掉（标签与分支都没有，只剩 `v1.7.x` / `v1.8.x` / `v1.9.x` 与 `v2.x`），所以这一步在 **ref 解析阶段**就会失败 —— 不是"扫描发现漏洞"，而是"这一步根本没跑起来"。原文写的是"OSV 无 SARIF 上报"，实际情况比这更靠前一步。现改用官方现行的可复用工作流并 pin 到 `v2.6.0` 的 commit，顺带拿到 SARIF 上报（Security → Code scanning）与 PR 上的增量注解。
   > 这条恰好就是 pin SHA 要防的那类事：当初 pin 的若是 SHA，上游删 ref 对我们毫无影响。"pin SHA"不是洁癖，它是**让上游的改动无法在无提示的情况下改变我们的行为**。
2. **最小权限与"被调用工作流"的配合要点。** 可复用工作流里自己声明的 `security-events: write` **只能被降级、不能被升级**：调用方不给足，SARIF 上传会因权限不足失败，而失败点在它内部，从我们的 workflow 里看不出来。所以顶层给 `contents: read`，`osv-scan` job 单独提到三项。
3. **`concurrency` 只对 PR 取消在跑。** 无脑 `cancel-in-progress: true` 会连 main 上的运行一起取消，而 main 的运行持有 package job 产出的 VSIX 构件 —— 取消了，那次提交就没有可下载的包。要取消的是"已经过时的结论"，不是"产物"。
4. **调用可复用工作流的 job 不能带 `timeout-minutes`。** 这类 job 只接受 `name` / `uses` / `with` / `secrets` / `permissions` / `needs` / `if` / `concurrency` / `strategy`，多一个键就是语法错误。所以超时只加在其余四个 job 上；`osv-scan` 的时长由它自己的步骤决定。

**新增守卫 `npm run check:workflows`**（`scripts/checkWorkflows.js`，零第三方依赖，与 `checkPackage.js` 同源做法）。理由：这些约束都属于"看着像已经满足"的类型（`@v4` 很像锁住了、job 里写了 `permissions` 很像工作流级也写了），靠人记住必然退化。它做三件事 —— 每个 `uses:` 必须 pin 到 40 位 SHA（`./` 本地 action 与 `docker://` 放行）、每个工作流必须有顶层 `permissions:`、禁止 `pull_request_target` / `workflow_run`；pin 了但缺 `# vX.Y.Z` 注释只告警。**做过反向自测**：故意写一个含四种错法的临时工作流，确认四种都被报出且退出码非零 —— 守卫若不能失败就等于没有。已接入 `npm run check` 与 CI 的 test job。

**没做**：lint 步骤。仓库至今没有 linter / formatter（属 P1-10），在一批"CI 配置改动"里顺手引入一套 lint 规则会把改动半径拉得过大，留到 P1-10 一起做。

### 战略层面的三个判断

1. **"真实 daemon 缺席"是最大的目标—现状落差**（见 §1.4）。要么补齐 Cordis 版真实 daemon（工程量大），要么把产品定位诚实地调整为"**协议 SDK + 完整参考实现 + 可直接用的 VSCode 前端**"，把 mock 降级为测试夹具而非卖点。目前 README 的表述会让用户误以为拿到的是完整产品。
2. **"会话跨窗口存活、长任务不拖垮编辑器"被过度承诺**。事实是：daemon 由扩展宿主 `spawn`（`daemonManager.ts:329-379`），并随 `deactivate()` 被 `kill`（`daemonManager.ts:142-145`、`extension.ts:146-150`）。VSCode 关闭 → daemon 死 → 进行中的会话随之死亡，且重启后不可 resume（`PROTOCOL.md:125`）。"不拖垮编辑器"成立（独立进程确实隔离了同步 fs/grep），但"跨窗口存活"仅在"还有窗口开着"时成立。建议：要么实现真正常驻的 supervisor（systemd/launchd/Windows 服务或脱离父进程的守护进程 + 独立的端口发现），要么下调文档表述。
3. **护城河确实存在，但投注不足**。(a) daemon 解耦、(b) 原生 Diff 审查、(c) 上下文捕获——这三条是同类产品普遍没做好的。建议把资源**集中在这三条上做到极致**（例如把前端做成"任何实现了协议的 Agent 都能接入的 VSCode 客户端"），而不是分散去追 MCP、多模态等"别人已有"的功能。

---

## 5. 优化与开发方案

### 阶段 1：修复与加固（P0，建议 3–5 个工作日）

**目标：消除"会破坏用户代码"和"会永久卡死"这两类问题。**

| # | 任务 | 关键改动点 | 验收标准 |
| --- | --- | --- | --- |
| 1.1 | 脏文档一致性 | `file.read` 支持缓冲区优先；`write_file/apply_patch` 落盘走 `WorkspaceEdit`（脏文档场景） | 新增集成测试：改文件不保存 → 发送 prompt → 断言 Agent 读到的是缓冲区内容；应用补丁后编辑器缓冲与磁盘一致且无内容丢失 |
| 1.2 | 补丁乐观锁 | `realAgent.ts:345-357` 落盘前比对当前磁盘内容与 `oldContent` | 单测：pending 后手动改磁盘 → accept → 断言 `applied:false` 且错误信息明确 |
| 1.3 | 取消能中断请求 | `AgentContext` 暴露取消信号；`Session.cancel()` 触发 abort；模型请求加首字节/空闲超时 | 单测：模型永不返回增量 → `cancel()` → 断言在 <1s 内收到 `session.ended(canceled)` |
| 1.4 | 能力下沉到连接/会话 | `server.ts` 把 `capabilities/runtime/approvalTtlMs` 从实例作用域移入 `Connection` | 单测/集成测试：两个连接分别 initialize 不同 `allowedTools`，断言互不影响 |

**同时建议补上的两项"顺手的加固"**（改动小、收益明确）：
- 5.1.1 `walkFiles` 加深度/条目上限与 visited 去重（P1-2 的最小可用版本，不必立刻改异步）；
- 5.1.2 `recycleStaleDaemon` kill 前校验进程命令行（P1-5）。

### 阶段 2：健壮性与可维护性（P1，建议 2–3 周）

1. **daemon 资源治理**：会话 TTL/LRU 回收（P1-1）、过期挂起项延迟清理（P1-7）、`step` 会话内计数（P1-8）。
2. **配置与协议正确性**：provider/baseURL 联动（P1-3）、`spawnExternal` 参数解析（P1-4）、暴露 `maxToolRounds`/`maxContextTokens`（P2-2）。
3. **类型与门禁**：新增 `tsconfig.web.json`（`allowJs+checkJs`）覆盖 webview/scripts；引入 ESLint + Prettier 并接入 CI（P1-10）。
4. **补上安全边界的单测**：把 `server.ts` 的握手判定、能力收敛、错误码映射抽为纯函数并单测；`wsClient` 用本地 ws server 做真实连接测试（P1-17）。
5. **测试提速**：`agent.test.ts` 改用假定时器，把全套从 ~28s 压到 <5s（P1-18）。
6. **CI 硬化**：pin SHA、`permissions`、`concurrency`、`timeout-minutes`、缓存 `.vscode-test`、OSV SARIF（P1-11）。**【2026-10-11 已实现；顺带发现并修掉 `osv-scanner-action@v1` 这个已不存在的 ref，见 §4「CI 硬化追记」】**
7. **Webview 重构**：拆分为 6 个 ESM 模块；`handleEvent` 加错误边界；`resetTurn` 修正（P1-12/13/14）。
8. **文档同步**：`SECURITY.md` 版本矩阵、用例数自动化（P1-9）；下调"跨窗口存活"的表述（战略判断 2）。

### 阶段 3：产品化与差异化（P2，建议 1–2 个月）

**优先级从高到低：**

1. **先把"真实 Agent 内核"这件事说清楚或做出来**（战略判断 1）。二选一：
   - **补齐**：实现 Cordis 版真实 daemon（仓库外），并用 `dsh.daemon.command` 接入，走通端到端；
   - **诚实定位**：README 明确"本仓库是参考实现 + 完整前端，mock agent 仅用于测试与演示"，并把 real agent（配 apiKey 即启用）作为默认路径重点打磨。
2. ~~**MCP 客户端**（P2-5）—— 在 daemon 侧实现 MCP Server 连接管理，工具经现有 `tools.ts` 网关暴露。这是从"自研 Agent"升级为"Agent 平台"的关键一步。~~ **【2026-10-01 追记：已决策不接入，理由见 §4「MCP 追记」】**
3. ~~**会话级事务回滚**（P2-6）—— 与现有 Diff 审批天然互补：审批是"事前拦截"，回滚是"事后兜底"。~~ **【2026-10-08 已实现，2026-10-09 加固；见 §4「会话回滚追记」】**
4. ~~**图片输入**（P2-4）—— 报错截图 → 让 Agent 直接看，是高频刚需。~~ **【2026-10-09 已实现，口径见 §4「图片输入追记」】**
5. ~~**Plan 模式**（P2-7）—— 复用审批基础设施，代价小、感知强。~~ **【2026-10-09 已实现；见 §4「Plan 模式追记」】**
3. **会话级事务回滚**（P2-6）—— 与现有 Diff 审批天然互补：审批是"事前拦截"，回滚是"事后兜底"。实现成本低（git stash / 影子目录），用户感知强。
4. ~~**图片输入**（P2-4）—— 报错截图 → 让 Agent 直接看，是高频刚需。~~ **【2026-10-09 追记：已实现，口径见 §4「图片输入追记」】**
5. **Plan 模式**（P2-7）—— 复用审批基础设施，代价小、感知强。
6. **可观测性升级**（P2-8）—— 结构化轨迹，为后续"成本面板""工具失败率"等功能铺路。

### 不建议做的事（避免走弯路）

- ❌ **不要在 Webview 里引入框架（React/Vue）**。当前 vanilla JS + CSP + esbuild 的组合体积小、无供应链风险、与 `--vscode-*` 主题变量配合良好；只需模块化拆分即可解决可维护性问题。
- ❌ **不要为了"协议可插拔"去新增第二套前端**（JetBrains/CLI）。在只有一份实现的前提下，这是纯负担；先让 VSCode 前端足够好。
- ❌ **不要在没有迁移路径时改动 `shared/protocol.ts` 的既有字段**。协议版本号目前是硬编码 `'1.0'`（`protocol.ts:144`），建议先补一个能力协商位（如 `capabilities.features: string[]`）再谈演进。
- ❌ **不要把 mock agent 的关键字逻辑进一步扩展**。它是测试夹具，越复杂越误导。

---

## 6. 优先级矩阵

| 象限 | 高影响 | 中影响 |
| --- | --- | --- |
| **低工作量** | **1.4 能力下沉**、**1.2 补丁乐观锁**、`walkFiles` 上限、`recycleStaleDaemon` 校验、CI 硬化 | `resetTurn` 修正、`step` 会话化、过期项清理、provider/baseURL 联动、`spawnExternal` 解析 |
| **高工作量** | **1.1 脏文档一致性**、**1.3 可中断请求**、~~**MCP 客户端**~~【2026-10-01 已决策不接入，见 §4「MCP 追记」】 | Webview 模块化、`server.ts` 纯函数抽取 + 单测、会话 TTL 回收、结构化轨迹 |

**建议执行顺序**：1.4 → 1.2 → 1.3 → 1.1 → 阶段 2 全部 → 阶段 3。

（先做 1.4 和 1.2 的原因：改动局部、风险低、可直接补单测；1.1 需要动扩展宿主与 daemon 两侧的接口，应放在对代码更熟悉之后。）

---

## 7. 本次核查的实测记录

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `npm run typecheck` | 通过，零错误 |
| 单元测试 | `npm test` | 18 文件 / **244 用例** 全部通过，27.57s（评估日快照；现为 21 文件 / 317 用例） |
| 最慢用例组 | `src/daemon/agent.test.ts` | 13 用例 / **14.3s**（依赖真实 sleep） |
| 运行时 | node v22.22.2 / npm 10.9.7 | `engines.vscode ^1.85.0`，CI 用 node 20，CONTRIBUTING 写 >=18 —— 本地 22 未测 |
| 构建产物 | `out/extension.js`、`out/daemon/index.js` | 均已存在且新鲜 |
| 打包产物 | `dist/vscode-dsh-0.2.1.vsix` | 约 390KB，落后于 0.4.0 |

---

## 8. 结语

这个项目的**架构品味明显高于它的产品完成度**。它把"Agent 与编辑器解耦"、"改动必须人审"、"上下文自动捕获"这三件正确的事做成了骨架，并且安全与工程纪律（canonical 护栏、默认拒绝、SecretStorage、buildId 防陈旧，评估当日 244 个用例、现已增至 317）都达到了可交付水平。

真正的短板不在代码质量，而在两处：**一是"真实 Agent 内核"仍缺席，用户拿到的实际是模拟 Agent；二是有几条会把用户的代码改坏的正确性通路（脏文档、无乐观锁）没被堵住。**

建议的路径很清晰：**先在 3–5 天内堵住 4 个 P0，再用 2–3 周把工程门禁和资源治理补齐，最后用 1–2 个月决定"补齐真实内核"还是"重新定位为协议前端"，并在这条路上补上会话回滚（MCP 已决策不做，见 §4「MCP 追记」）。**
