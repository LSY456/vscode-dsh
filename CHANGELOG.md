# Changelog

本项目版本变化遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增

- **上下文 token 预算**：realAgent 发送前估算 token（CJK 约 1、其余约 4 字符/token），
  超预算按整轮丢弃最旧工具轮次，保留 system + 初始请求 + 最近轮；`maxContextTokens` 可配（缺省 48K）。
- **会话标题生成**：会话开始时用模型生成 ≤40 字中文标题写入历史（失败/空/超时兜底 prompt 前 40 字），
  替代原来 prompt 无脑截断。
- **D1 面板重设计**：面板改为跟随当前主题的 VSCode 原生观感（统一用 `--vscode-*` 变量，浅色/深色/
  高对比主题自适应，不再写死深色）；工具调用聚合为一条可折叠「过程」时间线（步骤可展开输入/输出，
  失败自动展开）；推理流默认折叠只显示计时标签；用户消息带「Agent 看到了什么」上下文 chip；
  空态给出可点击的示例 Prompt；顶栏元信息展示当前 Agent 实现（mock / real）与模型名。
- **D2 挂起项待办条**：审批 / 补丁不再只躺在消息流里——同时投影到输入框上方常驻待办条
  （含 60s 过期倒计时与 Diff / 拒绝 / 应用 / 接受并记住），滚到任何位置都不会漏掉挂起决策。
- **D3 交互细节**：滚动锁定（用户上翻阅读时不再被流式输出硬拽到底，改为浮出「有新内容」）；
  Enter 发送 / Shift+Enter 换行 / Esc 关闭面板或停止会话；输入框自适应高度；回答可一键复制；
  历史与设置改为覆盖式面板（Esc / 点遮罩关闭），不再把对话顶下去。
- **E1 侧边栏常驻入口**：新增活动栏 dsh 图标 + `Agent` webview 视图（`onView` 激活，无需先记命令），
  另留 `dsh: 在编辑器列打开 Agent` 供大屏审阅；状态栏点击直接聚焦面板。
- **E2 会话管理**：顶栏「新会话」按钮与 `dsh: 新建会话` 命令（走协议 `session.create`）；
  历史列表点击即**切回该会话**（daemon 重放事件缓冲，可继续对话），daemon 重启过则退化为只读回放
  并自动新开会话，避免把消息发进失效会话。
- **E3 Diff 内闭环**：补丁 Diff 标题栏新增 应用 / 编辑后应用 / 拒绝 按钮（`editor/title` +
  `resourceScheme == dsh-patch`），审阅完不用再切回面板。
- **E4 挂起项超时可配**：新增 `dsh.approval.ttlSeconds`（缺省 60，范围 10–3600），经
  `initialize.capabilities.approvalTtlMs` 下达；daemon 统一盖戳 `expiresAt`，审批与补丁卡都带倒计时，
  过期即按拒绝处理。Agent 侧不再硬编码 60s。
- **协议第二实现（可插拔的可执行证据）**：新增 `examples/python-daemon/dsh_daemon.py`——
  Python 3 + **仅标准库**（WebSocket 服务端手写，RFC 6455 子集），实现
  `initialize` / `session.create` / `session.send` / `session.cancel` / `ping` / `shutdown`
  与一个 `read_file` 工具。配套 `npm run smoke:protocol` 拉起它并按协议走完整轮对话
  （18 项断言：端口上报、握手鉴权、事件时序、路径护栏、错误码、shutdown），
  把"后端可换"从文档承诺变成 CI 可验的事实；CI 双平台以 `--require` 运行，**禁止静默跳过**。
- **演示模式显式提示（消除静默降级）**：未配置模型 Key 时不再悄悄回落到 mock 关键字循环——
  `initialize` 新增可选字段 `agentReason`（`no-api-key` / `forced-mock`），扩展侧经
  `DaemonManager.onAgentInfo()` 在**每次握手成功后**推给面板；面板顶栏新增常驻**「演示模式」横幅**
  （警示色 + 成因文案 + 「配置模型」直通设置面板），模式 chip 改中文并在 mock 时着警示色。
  配好 Key 重启 daemon 后横幅自动撤下。同时把 mock 专属的关键字「咒语」入口从主路径移走
  （真实模型下隐藏，关键字表见 `docs/mock-agent.md`）。

### 修复

- **VSIX 混入本地会话记忆与内部文档（`.vscodeignore` 三条规则失效）**：打包清单里出现了
  `.workbuddy/memory/*.md`（本地工作记录）、`out/test/**`（集成测试产物）、全部 `*.map`
  以及 `docs/project-review.md`、`docs/strategy-agent-kernel.md` 两份内部文档——体积因此从
  214 KB 虚涨到 573 KB。根因是 `*.map` 与 `test/**` 在 vsce 下不按递归语义匹配（前者只命中
  根目录、后者打不到 `out/test/`），而 `.workbuddy/` 只进了 `.gitignore` 没进 `.vscodeignore`。
  现改为 `**/*.map`、`out/test/**`、`.workbuddy/**`，并显式排除两份内部文档；产物收敛到
  37 文件 / 214 KB，用户可见的 `docs/mock-agent.md` 与 `examples/python-daemon/` 照常保留。
- **Agent 读到过期内容、并会覆盖用户未保存的编辑（脏文档不一致）**：daemon 是独立进程，
  看不到 VSCode 的内存文档，所有读取都落到磁盘——而用户正在编辑尚未保存时**磁盘内容是过期的**。
  于是上下文里的「当前文件全文」取自编辑器缓冲区（`doc.getText()`），Agent 随后 `read_file`
  拿到的却是旧磁盘内容，diff 的 old 侧也是旧版本；更糟的是「应用」直接写盘，磁盘与缓冲区就此
  **分叉**，用户下一次 Ctrl+S 就会用旧缓冲区把 Agent 的结果覆盖掉。
  现引入**脏文档覆盖层**：扩展侧新增 `dirtyTracker`，在文档变更（去抖）、保存、关闭、打开以及
  *每次发消息前* 把「当前全部脏文档」全量推给 daemon（`workspace.syncDirty`）；daemon 以
  **连接**为单位维护覆盖层，读取一律覆盖层优先：
  - `file.read` 返回缓冲区内容并带 `dirty:true`；Agent 的 `read_file`/`apply_patch` 基准
    （diff 的 old 侧）同样取自缓冲区，并标注「编辑器未保存内容」；
  - 补丁落地新增第三条通路：目标为脏文档时**不写磁盘**。客户端（`diffProvider`）改为把改动
    应用到编辑器缓冲区（`WorkspaceEdit`）并回执 `applyInEditor`，两边重新对齐且改动保持
    未保存态供用户复核；客户端若未走编辑器，daemon **拒绝落盘**并说明原因（安全默认）；
  - 脏文档通路不做 P0-2 的磁盘乐观锁（基准本就非磁盘，比对必然误判），改由客户端在应用前
    自校验「缓冲区是否仍等于补丁基准」，不一致则提示重新发起；
  - 覆盖层按连接隔离（与 P0-4 同理），其它窗口的未保存内容不会污染本连接；超大文件只上报
    「脏」不上报内容（避免每次按键推几 MB 文本），读取回落磁盘但**写入仍一律避开磁盘**。
- **取消无法中断在途模型请求 / 模型静默时会话永久挂起**：原先仅靠轮询 `isCanceled()` + 在
  `onChunk` 内检查来感知取消——若模型端在连接建立后长时间不吐任何增量（网关挂住 / 连接半开 /
  服务端排队），`onChunk` 永不触发，取消也因此得不到响应，会话永久卡在 `running`。现两路兜底：
  ① `AgentContext.onCancel` 让 server 在 `session.cancel()` 时**同步**转达取消，Agent 立即
  `abort()` 在途 fetch；② 模型层新增**空闲超时**（每个增量重置计时，静默超过阈值即以
  `TimeoutError` 中断），并新增 `dsh.model.idleTimeoutSeconds`（缺省 60，0 关闭）可配。
  另修正中断被当作"正常完成"的隐患：SSE 解析在 `signal.aborted` 时改为**显式抛错**，
  平台原生 AbortError 也归一到可读文案，不再返回半截内容。
- **补丁静默覆盖用户并发修改（乐观锁缺失）**：补丁在发出 `file.patch.pending` 时对目标文件拍了
  快照，但用户在审阅 Diff 到点「应用」之间若从外部改动了该文件（编辑器保存 / 另一会话的补丁 /
  外部工具），accept 后会直接写盘把那段并发修改**静默覆盖**。现落地前以「快照 vs 当前磁盘」做
  乐观并发校验（`checkPatchConflict`）：不一致即拒绝应用，`file.patch.result` 返回
  `applied:false` + `error`，并在消息流显式告知冲突，请用户重新读取后再发起修改。文件「从无到有」
  的新建语义不视为冲突。mock 与 real 两条补丁链路均已加固；`tools.test.ts` 补 6 例纯函数用例，
  `realAgent.test.ts` 补 3 例端到端回归（外部修改 / 无误伤 / 抢先创建）。
- **多窗口共用 daemon 时能力声明互相污染**：`capabilities`（`allowedTools` / `allowedDirs` /
  `maxConcurrency`）、挂起项 TTL 与模型运行时配置此前定义在 **daemon 服务实例**作用域——而同一
  工作区的多个 VSCode 窗口会复用同一 daemon（auto 探测复用 `.dsh/daemon.json`），后握手的窗口
  会把先前窗口声明的工具白名单整体覆盖为默认值，安全边界被跨窗口静默削弱（A 窗口禁用的
  `bash_execute` 可能因 B 窗口握手而重新可用）。现下沉到 **连接作用域**：每个 WebSocket 连接各持
  一份运行状态，`initialize` 只影响本连接，互不干扰；冒烟新增「连接级能力隔离」回归断言
  （严格连接与宽松连接同 daemon 并存，各自语义独立生效）。
- **用户消息重复回显**：Webview 本地回显与扩展回发 `user.message` 会各渲染一条，导致每条提问出现
  两个气泡；现统一由扩展侧回发（并携带上下文 chip）。
- **补丁「应用」后待办条不消失**：待办条释放与卡片最终结果此前共用一个状态位，点了应用仍显示待办；
  现拆分为「已表态（responded）」与「已回执（decided）」两个状态。
- **「编辑后应用」在主界面上根本不可用**：`dsh-patch` 原先由 `TextDocumentContentProvider` 提供，
  VS Code 视其为只读文档——用户在 Diff 右侧**敲不进字**（集成测试 T6 复现），该功能只能靠
  `WorkspaceEdit` 生效。现改为可写的 `FileSystemProvider`，Diff 右侧可正常编辑并应用。
- **断线重连续跑与切回历史会重复落库 / 重复渲染**：daemon 重放事件缓冲时，扩展会再次把回答写进
  `.dsh/history.json` 并叠加渲染到面板；现在重放前先重置视图，且重放期间不回写历史。
- **`[hidden]` 属性在覆盖式面板与待办条上失效**：`.sheet`（设置 / 历史面板）与 `.pending-bar`
  自带 `display: flex`，而**作者样式里的 `display` 会覆盖 UA 样式表的 `[hidden]{display:none}`**
  （同特异性下作者来源优先），导致这些元素即使带 `hidden` 也可能照常显示。已在样式表顶部补
  全局兜底 `[hidden] { display: none !important; }` 并注明原因（新增元素不必再各自写 `[hidden]` 变体）。

## [0.4.0] - 2026-09-02

### 新增

- **原生 function calling**：`ChatModel` 支持 `tools` 参数（ToolDefinition JSON Schema），OpenAI 兼容
  `tool_calls` 与 Anthropic `tool_use` 流式解析（按 index 累积归一为原生 ToolCall）；`realAgent`
  工具 schema 驱动原生调用、fenced 解析兜底，工具结果回灌带调用 id。
- **smokeReal 场景三**：真实连通冒烟新增原生工具探针（给 `chat` 传 `tools`，检查 `result.toolCalls`），
  与场景一（连通，硬断言）/场景二（fenced 探针，软报告）共同覆盖三条链路。
- **会话历史持久化**：历史外置到工作区 `.dsh/history.json`（跨 daemon 重启 / 换机持久），不再依赖 workspaceState。
- **grep / glob 只读搜索工具**：新增跨文件关键字搜索（grep）与文件名通配定位（glob），免审批只读、
  路径护栏 + 匹配上限截断，跳过 node_modules/.git 与二进制/超大文件。

## [0.3.0] - 2026-08-26

### 新增

- **A1 Webview Markdown 渲染**：marked + GFM + highlight.js 代码高亮，DOMPurify 统一净化
  （配合 CSP 双层防 XSS），流式结束一次性安全渲染。
- **A2 流式渲染批处理**：token 级 delta 按帧（rAF）节流写 DOM，消息结束前冲刷兜底，长回答不再高频 reflow。
- **A3 会话历史**：extension 侧 workspaceState 持久化（按工作区隔离）、历史回放、异常中断最后一段兜底落库。
- **A4 配置面板 + 凭据安全化**：apiKey 迁移 VSCode SecretStorage（旧明文自动回迁并清除）、
  面板化模型配置（API Key / 模型 / BaseURL / 预设），保存后一键重启 daemon 生效。
- **B1 信任记忆（免审批白名单）**：审批卡「接受并记住」按「程序+首参」脱敏生成 prefix 规则、
  高危程序仅精确匹配、工具白名单优先于信任放行、规则落 `.dsh/trust.json`（`trust.list` / `trust.clear`）。
- **P2 补丁编辑（Diff 编辑后应用）**：补丁卡「编辑并应用」两段式，`file.patch.respond`
  携带编辑后 `content` 写盘，daemon 写盘优先用户编辑后的内容。
- **C1 CI 安全扫描**：新增 `security` job（`npm audit --omit=dev --audit-level=high` 生产依赖
  高危阻断 + OSV-Scanner 全量扫描）。
- **C2 daemon 日志落盘**：tee stdout/stderr 到 `.dsh/logs/daemon.log`（轮转归档 + 目录 0700 / 文件 0600）。
- **C3 trajectory.list 协议化**：以协议方法回放脱敏轨迹，替代直接读 `.dsh/trajectory/*.jsonl`。
- 集成测试：`@vscode/test-electron` 启动真实 VSCode Extension Host，自动化 T1-T5
  （激活连接 / 补丁流程 / 审批流程 / 路径护栏 / 编辑后应用），`npm run test:integration` 运行。
- CI `integration` job（ubuntu headless，`xvfb-run`）覆盖扩展宿主层 ↔ daemon 完整闭环。
- 扩展 `activate()` 暴露测试钩子（`DshApi`：daemon / diff），运行时不改变产品行为。
- 模型多点位：Anthropic Messages 适配与 `createModel` 工厂，经 `dsh.model.provider`
  （auto/openai/anthropic）选择；OpenAI 兼容仍覆盖 DeepSeek/通义/本地推理等。
- 命令执行沙箱：可插拔后端（Linux 检测到 bubblewrap 时命名空间隔离）+ 应用层兜底
  （cwd 约束 / 环境最小化 / 超时进程树终止），降级原因经日志显式披露。
- 真实连通冒烟：`npm run smoke:real`（需真实 apiKey，不参与 CI）用真实 endpoint 的 SSE 流
  验证 OpenAI 兼容与 Anthropic 两条适配链解析出正文、流式增量触发；缺 key 诚实跳过。

### 变更

- esbuild `0.23.1` → `0.28.2`（消除 dev-server 漏洞，OSV 恢复全量硬门禁）。
- 测试基线更新为 164 个用例（在 153 例之上追加命令沙箱、多 provider、密钥脱敏、日志落盘等）。

### 修复

- mock 目标路径解析：修正 `extractPath` 正则捕获组（`rel[0]`），无匹配时兜底到工作区 `output.txt`
  （原 `rel[1]` 恒为 undefined 且 `process.cwd()` 会误落到进程启动目录）。
- 陈旧 daemon 复用防护：esbuild 每次构建写随机 `buildId` 指纹，扩展比对不一致即回收旧 daemon
  （杀掉旧 pid + 删除端口文件 + 重启），避免升级后连旧进程导致行为漂移。

## [0.2.1] - 2026-08-17

### 安全（企业级加固）

- **路径护栏 canonical 化（修复符号链接/联结穿越）**：`paths.ts` 以 `fs.realpathSync` 解析
  后的规范路径做包含判断，拒绝工作区内 symlink / Windows junction 逃逸、`..` 逃逸、NUL 与
  Windows 备用数据流（ADS）；`tools.ts` / `agent.ts` / `server.ts` 全链路改用 canonical 解析。
- **命令默认拒绝**：`bash_execute` 在原有"人工审批"之外，内置高危拒绝规则（`rm -rf`、fork bomb、
  磁盘格式化、写块设备、`curl|sh`、shutdown/reboot 等）**始终生效**（`DEFAULT_DENY_PATTERNS`）。
- **轨迹秘密脱敏 + 异步缓冲**：轨迹写入前对密钥 / Token / 密码词面统一脱敏；改同步 `appendFileSync`
  为内存缓冲 + 批量落盘（会话结束 / daemon 关闭时 flush）；目录 `0700`、文件 `0600`。
- **新增 `SECURITY.md`**：安全模型、信任边界、已知残余风险与漏洞报告流程。

### 变更

- 版本号单点化：`shared/version.ts`（`VSD_DSH_VERSION`）统一扩展宿主与 daemon 版本，避免硬编码漂移。

## [0.2.0] - 2026-08-17

### 新增

- **P3 真实 daemon**：模型适配层（OpenAI 兼容流式客户端，区分思维链 `reasoning_content` 与正文 `content`）。
- **P3 真实 Agent 循环**：与 mock 实现共用同一 `AgentContext` 契约；模型流式推理/回答 → fenced
  toolcall 解析 → 工具分派 → 结果回灌循环，支持取消与轮数上限。
- **P3 真实工具沙箱**：`read_file` / `list_dir`（只读，路径护栏）；`write_file` / `apply_patch`
  （全量覆盖 / 字符串替换，走 Diff 审查后落盘）；`bash_execute`（命令策略门控 + 人工审批）。
- **P3 轨迹持久化**：`trajectory.record` 追加写入 `.dsh/trajectory/<sessionId>.jsonl`，命中大小上限自动归档。
- **协议扩展**：`InitializeParams.model`（baseURL / model / apiKey / agent）、
  `InitializeResult.agent`（`mock | real`，标明实际生效实现）。
- **自动切换**：配置 `dsh.apiKey` 后 daemon 自动启用真实模型，否则回退内置模拟（演示/测试不变）；
  新增 `dsh.model.baseURL` / `dsh.model.model` 配置项，CLI 支持 `--agent mock|real|auto` 与 `--fake-model`。
- **测试与 CI**：新增 model / tools / trajectoryStore / realAgent 四组 vitest 用例（累计 67 个）；
  冒烟测试新增"真实 Agent 流水线"（`--agent real --fake-model`：读/写工具 + 轨迹落盘）。

### 变更

- daemon 版本号升至 0.2.0，扩展版本同步 0.2.0。

## [0.1.0] - 2026-07-31

### 新增

- 首个可运行版本：协议契约、参考 daemon、Extension Host、Webview UI。
- **P0 工程质量**：vitest 单元测试、GitHub Actions CI、OutputChannel 分级日志、VSIX 打包。
- **P1 协议加固**：审批/补丁强校验 + 过期同步、会话状态机 + 事件缓冲 + `session.resume` 断线续跑、
  路径护栏、能力分级（allowedTools / allowedDirs / maxConcurrency）、多会话并发、
  `file.read` 按需读取、心跳检测。
