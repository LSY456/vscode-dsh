# Changelog

本项目版本变化遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增

- **采样参数 `dsh.model.temperature`（0–2）与 `dsh.model.maxTokens` 可配**：温度此前是写死在代码里的
  `0.2`；输出上限则在 Anthropic 链路里写死 4096、在 OpenAI 兼容链路里**根本不发送** —— 前者用户
  改不了，后者想改只能改代码。现两个值都进 `package.json` 与面板「模型设置」，随握手下发到 daemon。
  几条关键取舍：
  ① **"未配置" ≠ "配置成缺省值"** —— 两个字段刻意**不设 `default`**，`null` 表示"用户没配过"：
  面板留空、daemon 不下发，温度继续走模型层缺省（0.2）、上限继续不发送。若在扩展侧就回落成 0.2，
  Anthropic 链路会被顺带改变行为（它此前**根本不在请求体里带温度**，等于沿用 Anthropic 自己的
  缺省），那不是"加一个可配项"该带来的变化。
  ② **上限留空 = 不发送该字段**，而不是替用户写一个数进去：省略时上限由服务端决定，写死一个值等于
  替用户压低默认输出长度，还会把"没配"和"配成这个数"变成同一件事。Anthropic 的 `/v1/messages`
  把 `max_tokens` 列为必填，故未配置时回落 4096。
  ③ **温度区间两家不同**（OpenAI 0–2 / Anthropic 0–1）：越界值**钳制**而不是原样发出 ——
  原样发出会换来一个与用户配置无关的上游 400，而他只会看到"请求失败"。
  ④ **写入侧钳制**：温度是小数，不能复用整数的收敛函数（会把 `0.2` 四舍五入成 `0`），故单开一条
  保留小数的路径；非数字则**丢弃本次写入**，而不是塞一个缺省值进去（用户没填 ≠ 他想改成缺省值）。
  ⑤ 面板判断"是否填写"用的是**空串**而不是真假值 —— 温度 `0`（最确定）是合法值，用 `if (x)` 会把它丢掉。

### 修复

- **`PROTOCOL.md` 漏记了两个已在用的 `initialize.model` 可选字段**（`maxToolRounds` /
  `maxContextTokens`）：协议文件是第三方实现照抄的**规格样本**，字段"代码里有、文档里没有"，
  实现者就无从知道可以下发、也读不出缺省语义。本次补上这两个，并一并记录新增的
  `temperature` / `maxTokens`。

## [0.8.0] - 2026-10-04

### 新增

- **`dsh.history.maxSessions`**（缺省 50，`0` = 不限）：会话历史此前只有硬编码上限，用户既改不了、
  也无从知道它会一直增长。现可配置，并且**读取时与落盘时都按创建时间裁剪** —— 旧版本留下的超大
  `history.json` 在面板下次打开时就收缩，不必等新会话写入。上限做成 getter 现读，改设置立刻生效，
  不必重开面板；被裁会话的流式缓冲一并清掉，不留悬挂引用。
- **模型名改为下拉选择，并自动跟随 DeepSeek 官方更新**：模型名是**易错且会变的外部事实**——
  让用户手写字符串，错一个字母就是一次必然失败的请求；而 DeepSeek 改名（`deepseek-chat` /
  `deepseek-reasoner` 已于 2026/07/24 弃用）用户根本无从得知。现「模型设置」里的模型名收成**下拉**，
  只有 API Key 还需要手填。候选列表三级来源：① **在线** `GET {baseURL}/models`（OpenAI 兼容协议，
  官方一上架新模型，下次打开设置面板就会出现在下拉里；24h TTL 缓存、打开面板时后台刷新、
  换端点或换 Key 即失效重取，多个面板同时打开只打一次网络）；② **内置快照**（无 Key / 离线 /
  端点不通时的兜底，并显式标注快照取材日期，免得被当成实时列表）；③ **当前配置值本身**——
  不在列表里也保留为选项并标注「当前配置，不在已知列表中」，**绝不因为"列表里没有"就静默改掉
  用户已配好的模型名**（只有用户主动另选才会变）。下拉下一行说明列表从哪来、为什么没拿到，
  失败按状态码给确定说法（401 Key 无效 / 403 无权 / 404 端点无此接口 / 超时 / 返回不是列表），
  不做"请检查配置"这类猜测式提示；失败原因里不含任何凭据。无 Key + 官方端点时**不发请求**
  （必然 401，白等一次超时）。面板打开即渲染（先用缓存/快照），在线列表随后以事件补上，
  且刷新回来的列表**不会把用户刚选中的项弹回去**；列表为空时保持原样，避免"空下拉 + 误点保存"
  把配置改坏。API Base URL 与 `provider` 未动，仍是自由输入：自定义网关的自定义模型名会由
  在线列表原样带出来。
- **状态行常驻显示账户余额（DeepSeek 官方 `GET /user/balance`）**：Agent 跑起来后"还剩多少钱"是
  使用者最关心、却最看不见的一件事 —— 余额不足时的报错来自上游（`is_available: false` / 402），
  那时已经晚了一步。现在余额以 chip 常驻状态行（模型名右侧），悬停给出明细（赠金 / 充值 / 更新时间），
  点击立刻重取；**余额不足**时复用既有的警示 chip 样式，不必等报错才知道。刷新时机：surface 就绪、
  握手成功、会话结束（token 用掉了）、改了 Key/端点、手动点击；网络请求按 60s TTL 节流，
  多个面板同时打开只打一次。
  几条刻意的取舍：
  ① **只在 DeepSeek 官方端点上取** —— `/user/balance` 是账户级接口，用户自配的第三方网关未必有；
  既不为"锦上添花的展示"把 API Key 送到第三方，也不产生必然的 404；
  ② **未知就整块隐藏**，不显示 `0` 或 `--`（0 余额是很重的结论，不能靠兜底值给出）；
  ③ 刷新失败**保留上一次已知值**（只记日志）—— 一次网络抖动就显示"没有余额"比数字稍旧更误导；
  换 Key / 端点则相反：旧数字立刻撤下，并用配置代次校验让"迟到的旧账号结果"一律作废；
  ④ 金额原样透出，不换算不四舍五入；文案与日志里都不含凭据。
- **`dsh.agent.maxToolRounds`（缺省 8，1–50）与 `dsh.agent.maxContextTokens`（缺省 49152，4000–1000000）
  补进配置项与面板**：这两个 Agent 循环预算此前是**死配置** —— 只有 daemon 侧的 `realAgent` 读得到，
  扩展从不下发、`package.json` 里也没有条目，用户根本改不到（而 CHANGELOG 早先声称"可配"）。
  现补进 `package.json` 与面板「模型设置」，随握手下发给 daemon（保存后重启 daemon 生效），
  缺省值收成协议共享的常量，扩展与 daemon 不再各写一份。两条刻意的取舍：
  ① **留空 = 不修改** —— 绝不用 `Number('') = 0` 提交空字段，那会把"没填"变成"把上限设成 0"；
  加载时字段缺失也留空，不显示 `0`（用户会误读成"上限就是 0"）。
  ② **写入侧钳制** —— 输入框可以被开发者工具绕过，而这两个值直接决定"一轮能跑多少工具、上下文多大"，
  越界值一律收敛进区间，非数字回落到缺省。

- **上下文 token 预算**：realAgent 发送前估算 token（CJK 约 1、其余约 4 字符/token），
  超预算按整轮丢弃最旧工具轮次，保留 system + 初始请求 + 最近轮；`maxContextTokens` 可配（缺省 48K）。
- **会话标题生成**：会话开始时用模型生成 ≤40 字中文标题写入历史（失败/空/超时兜底 prompt 前 40 字），
  替代原来 prompt 无脑截断。
- **D1 面板重设计**：面板改为跟随当前主题的 VSCode 原生观感（统一用 `--vscode-*` 变量，浅色/深色/
  高对比主题自适应，不再写死深色）；工具调用聚合为一条可折叠「过程」时间线（默认折叠，头部显示
  「N 步 · 耗时 · N 失败」，步骤可展开输入/输出）；推理流默认折叠只显示计时标签；
  用户消息带「Agent 看到了什么」上下文 chip；
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

### 变更

- **声明 `extensionKind: ["workspace"]`（P1-1）**：daemon 由扩展宿主 `spawn`、工作区根取自
  `workspaceFolders`，所以扩展必须加载在**工作区侧**。此前未声明，Remote-SSH / WSL / Dev Containers
  下可能被加载到 UI 侧 —— 那样 `spawn` 的是本地进程，而工作区根会是一个远端根本不存在的本地路径，
  路径与进程语义全错，且不会报任何错。**注**：这只是"声明"，真实 Remote 环境下的端到端行为仍需
  人工按清单实测（见 `docs/vscode-platform-audit.md` 的 Batch B 第 5 条，本轮未做）。
- **状态文案收成共享模块（`src/statusLabel.ts`，P1-3）**：状态栏与通知此前直接拼内部枚举
  （界面上会出现 `dsh: connected`、`dsh daemon 状态: connecting`），而面板里另有一份中文映射 ——
  同一件事两处维护。现两侧共用一份（`DaemonStatus` 也改由它定义），正文只给「已连接 / 连接中… /
  出错」这类可读文案，原始枚举退到 tooltip 与 OutputChannel 供排障。
- **`dsh.apiKey` 契约收敛（P1-2）**：实现早就是「系统密钥库（SecretStorage）优先 + 旧明文一次性
  迁移」，而 `package.json` 的描述仍在教用户把明文 Key 写进 `settings.json` —— 声明与实现自相矛盾。
  现标记为**已弃用**（保留该 key，让旧配置的一次性迁移仍能读到；直接删属性会让旧明文静默失效），
  并把 `dsh.apiKey` 一并列入受限配置：凭据不接受工作区设置下发，与 `dsh.daemon.token` 同理由。
- **「演示模式」横幅改为通用状态横幅**：同一块 UI 现在承载两种"当前为什么不好用" —— 受限模式
  （工作区未被信任）与演示模式（未配 Key / 被显式指定为 mock），**受限模式优先**：未受信任时
  daemon 根本没启动，此时再讲"没配 Key 所以是模拟回复"纯属误导。元素随之更名
  （`#demo-banner` → `#state-banner`、按钮 `#btn-demo-config` → `#btn-state-action`），
  按钮动作由当前状态决定（去信任 / 去配置模型）。
- **空态起点改为「按会话轮换的建议池」**：原先写死两条（`解释当前文件的关键逻辑` /
  `修改当前文件里的 TODO`），每次新建会话都原样重现，看第二眼就成了装饰；且这两条只覆盖
  "读现有文件"一种场景，对新任务并不总是有意义。现按会话号从 9 条池子里**确定性**轮换 3 条
  （`src/webview/suggestions.js`，按意图分：解释 / 排查 / 修改 / 补测 / 评审 / 定位 / 通读 /
  起草提交信息 / 重构）。点击行为不变：**填入输入框而非直接发送**（避免误触）；同一个会话号必然
  得到同一组（可复现），不同会话号才换。演示模式专属入口（高危工具审批）仍单独追加、只在 mock 下
  可见，且通用条目一律自然语言——不再掺 mock 的关键字"咒语"（mock 的补丁分支本就认「修改」这个自然词）。
- **状态行只保留「连接状态 + 当前模型」**：此前底部状态行挂着 `真实模型 · deepseek-flash` 与
  `session sess_xxxxxxxx` 两枚徽标。前者里的"真实模型"是多余定语——能列出模型名就说明在跑真模型，
  而"当前不是真模型"由演示模式横幅专门说明，现只显示模型名（mock 时显示「演示模式」）；
  后者是排障信息（`.dsh/trajectory/<sessionId>.jsonl` 按它命名），对使用者没有意义，
  现从界面上移除，改为落在状态行的 `data-session` 与悬停提示上，需要时仍可查。
- **面板布局重编排（对齐标准 Agent 工具的信息层级）**：此前顶部叠着「品牌栏 + 元信息栏」两条 bar，
  底部又叠着「执行迹线 + 待办条 + 输入区」三个区块，在 ~300px 侧边栏里有效信息密度极低。现重排为：
  - **顶栏收成一行**：标识 + 当前会话标题（有才显示）+ 图标动作组（新建 / 迹线 / 历史 / 设置）；
    连接状态、当前 Agent 实现与会话号下移到输入区下方的状态行，对齐 IDE 状态栏心智。
  - **消息改「角色列 + 全宽正文」**：弃用左右对齐气泡——agent 输出的是报告/代码而非寒暄，右对齐在
    窄侧栏会压缩长 prompt，且 assistant 缺乏视觉锚点；推理 / 过程 / 审批卡 / 补丁卡统一对齐到正文列，
    角色标记（`你` / `dsh`）提供固定锚点。
  - **执行迹线改为按需打开**：它与会话流里的「过程」时间线语义重叠，原先常驻底部还占一行；现收进
    顶栏图标按钮（带步骤计数徽标），只在点开时以覆盖面板呈现，不再主动打断阅读。三个覆盖面板
    （迹线 / 历史 / 设置）互斥，Esc 与遮罩统一关闭。
  - **输入区卡片化**：文本框与动作收进带 focus 环的容器；空态补齐标识、引导说明与快捷键提示。
- **`scripts/uiPreview.mjs`（开发辅助）**：用真实 `media/webview.html` + `media/webview.js` 经 jsdom
  渲染出静态预览页（`scripts/ui-preview.html`），改完样式不必装 VSIX 就能先在浏览器里比对观感；
  产物落在 `scripts/` 下，不进 VSIX。

### 修复

- **状态行上的 daemon 版本号停在 5 个小版本之前（版本号写了两份，手写的那份没人管）**：
  `shared/version.ts` 一直是手写的 `VSD_DSH_VERSION = '0.3.0'`，而 `package.json` 已经走到 0.8.0。
  该常量被 daemon 上报为 `daemonVersion`，直接渲染成「已连接 daemon v0.3.0」——**用户可见**，
  且没有任何测试或机制会发现它，因为凡是会随发布变动的都只在 `package.json` 里。
  现改为**构建时从 `package.json` 注入**（`esbuild.js` 的 `define`），版本号在物理上只剩一份；
  源码直跑（vitest / ts-node）回落到 `0.0.0-dev` 占位符 —— 占位符刻意不写成合法发布号，
  否则它又会变成"第二份真相"。冒烟测试补断言：daemon 上报版本必须等于 `package.json` 版本
  （守的就是这条症状本身）。同批清掉同族的陈旧版本：`SECURITY.md` 支持版本、`package-lock.json`
  顶层版本（`0.4.0` → `0.8.0`）。
- **每轮工具调用的原始 JSON 固化在答案气泡里，并随会话历史落盘**：模型按约定把工具调用写在正文里
  （```toolcall / ```json），而 `streamChunk` 把模型原始正文**原样**当作 `message.delta` 推给面板 ——
  于是答案区除了"我先看看目录。"还跟着一整块 `{"tool":"list_dir","input":{"path":"."}}`，
  `message.done` 定妆后永久留存，并经扩展写进 `.dsh/history.json`。
  现加一道**展示层**过滤器，只吞「确实解析成工具调用」的 fenced 块：别种语言标签的代码块
  （```python 里恰好有 `"tool"` 字段）、不含工具调用形状的 JSON、未闭合的围栏一律保留
  （用户可能就是要看那段 JSON；未闭合的是模型的坏输出，藏起来只会让人无从诊断）。
  过滤器按**增量**工作（围栏常被切在两个 chunk 之间，故不能对单块做正则替换），只影响推给人看的
  文本，**回灌给模型的 `content` 保持原样**（改写模型自己的输出会让它下一轮看到一段自己没说过的话）；
  收束请求不提供工具，那里正文里的围栏是内容而非调用，故不剥离。
- **`realAgent` 里还留着第二份上下文预算常量与硬编码的轮次上限**：上一条把缺省值收进
  `shared/protocol.ts` 时漏掉了 daemon 侧这份本地拷贝（`48 * 1024` 与 `?? 8`），
  数值虽与协议常量相同，却仍是"第二份真相" —— 一并改为引用协议共享常量。
- **没有打开文件夹时，"工作区"被悄悄换成扩展宿主的工作目录（P0-2）**：`getWorkspaceRoot()` 在无
  `workspaceFolders` 时回落 `vscode.workspace.rootPath ?? process.cwd()`，于是 daemon 的工作区成了
  VS Code 安装目录或用户主目录——端口文件、`.dsh/` 落盘、以及路径护栏的 root 全跟着跑偏，
  而用户完全不知道 Agent 在操作哪个目录（`rootPath` 本身也早已废弃）。现改为**明确拒绝启动**
  （状态 `disabled` + 「请先用『文件 → 打开文件夹』打开一个工作区」），不再猜根。工作区根同时收成
  单点 `resolveWorkspaceRoot()`：`daemonManager` / `contextCapture` / `webviewPanel` 三处此前各自取
  `workspaceFolders[0]`，现统一走它；多根工作区会记录"只作用于第一个文件夹"。
- **`.dsh/` 不自守，会话全文与工具轨迹会出现在用户仓库的 `git status` 里（P0-3）**：`history.json`
  （对话全文）、`trajectory/*.jsonl`（工具输入输出）、`logs/daemon.log`、`trust.json` 都不带忽略规则，
  轻则刷一屏未跟踪文件，重则被 `git add -A` 把含业务代码与对话内容的记录提交进公司仓库。
  现由 daemon 启动与扩展写历史两处统一经 `shared/dshDir.ts` 的 `ensureDshDir()` 建目录，并在目录名
  确为 `.dsh` 时写下自守 `.gitignore`（内容 `*`；已存在则不覆盖用户的规则）。
- **调试命令每次点击都新建一个 `dsh Debug` 输出通道且从不回收（P2-3）**：反复触发会持续堆叠输出
  面板。现改为注册期创建一次并交给 `context.subscriptions` 回收。
- **未受信任的工作区里照常拉起 daemon（打开恶意仓库即可执行任意进程）**：`dsh.daemon.command`
  在 auto（默认）模式下被当作**可执行文件直接 `spawn`**，而它是普通 `window` 作用域设置 ——
  **工作区设置可以覆盖**，且激活流程无条件 `daemon.start()`。于是仓库里放一份 `.vscode/settings.json`，
  用户点开 dsh 面板就等于让它在本机执行任意进程（同类向量：`dsh.capabilities.allowedTools` 放开
  bash 工具白名单、`dsh.model.baseURL` 把 API Key 引到攻击者端点）。
  现补齐**三层防护**（缺任何一层都能被绕过）：
  ① `capabilities.untrustedWorkspaces.restrictedConfigurations` 声明这批配置项（工作区设置对其不生效）；
  ② 会执行进程的项钉成 `"scope": "machine"`（机器作用域同样不可被工作区覆盖）；
  ③ **运行期门禁** —— `DaemonManager.start()` 前置工作区信任判定，未受信任时**连子进程都不拉起**，
  状态置为 `restricted`；`restart()` 也走 `start()`，因此命令 / 状态栏 / 面板「重启 daemon」/
  断线重连全被同一道门覆盖，没有绕行路径。
  受限模式的用户面是"可自救"的：面板状态横幅 + 状态栏警示项 + 命令 `dsh: 信任此工作区`
  （`enablement: !isWorkspaceTrusted`，已信任时不出现），并接住 `onDidGrantWorkspaceTrust`
  自动补齐启动 —— 信任完不必重启窗口。另声明 `virtualWorkspaces: false`（需要真实文件系统）。
- **点「新建会话」后新页面一片空白（欢迎块不见了）**：清空视图后紧跟的「已新建会话：sess_xxx」
  系统行同样走 `addMessage()`，把刚露出来的空态又藏了回去——于是新会话只剩一行会话号，
  标识、标题、引导说明与可点的起点全都没了。根因是空态可见性被写在两处各管一半
  （`addMessage` 单向隐藏、`clearMessages` 单向恢复）。现改为**单点决定**：可见性只由
  「消息区是否为空」推导（`syncEmptyState()`），任何"清空后紧跟一条消息"的路径都不会再把它吃掉。
  同时「新建会话」不再往消息流里插系统行——空态本身就是"已新建"的反馈，而那句话里的会话号
  对使用者没有意义（排障那份在状态行的 `data-session`）。
- **会话「自动中断」且不返回任何信息（工具轮次耗尽后静默收场）**：主循环在工具调用轮次
  （`maxToolRounds`，缺省 8）用尽时只是退出 `for`，随后直接上报 `completed`——从不向模型索要
  最终结论。而工具调用轮里模型的正文通常只有一句"我先看看…"，于是用户看到一屏工具行加半句
  开场白，会话就没了下文。真实迹线可证：两个子会话都恰好跑满 8 轮工具后 `session 结束：completed`，
  产出文本只有 `我先确认一下工作区结构，找到「当前文件」。` 这类开场白，**没有任何结论**。
  现改为：轮次耗尽时追加一条「工具调用轮次已达上限，不能再调用工具」的指令，并**刻意不提供
  工具定义**，再请求一次收束回答；若收束仍无正文则显式告知用户（附"可再发一条消息让我继续"
  的指引）；若收束请求本身失败则以 `reason=error` 收尾——已经报了 error 却宣称"已完成"是自相矛盾的。
- **`list_dir {"path":"."}`、`read_file {"path":"src/a.ts"}` 这类工作区相对路径被判「路径越界」**：
  护栏用 `path.resolve(target)` 解析，而它按 **daemon 进程的 cwd**（未必等于工作区根）展开。
  模型天然会写相对路径，一撞即失败，只能改用需要用户审批的 `bash_execute`（ls / dir）去列目录
  ——实测两个真实会话的 8 轮预算里有 5~6 轮耗在"先把目录列出来"上，还伴随 5~6 次审批弹窗，
  等轮到真正作答时预算已见底。现改为相对路径按**工作区根**解析（在 `assertPathInside` 单点处理，
  绝对路径与 canonical / 符号链接越界判定完全不变），并在系统提示与工具描述中写明两种写法。
- **一次网络抖动就等于整场会话中断**：模型请求此前没有任何重试。真实会话里三次「模型调用失败」
  有两次在 ~110ms 内返回，而 19 秒后同一请求即成功——典型瞬时失败。现对**网络层错误与 429/5xx**
  自动重试（缺省 2 次，退避 600ms / 1200ms）；其余 4xx（401/402/404…）是确定性错误，不重试。
  硬约束：**已经向前端推送过增量就不再重试**，否则同一段正文会被推第二遍。
- **会话结束原因直接显示协议内部枚举**：`session.ended` 把 `completed` / `error` / `canceled`
  原样写进系统行，用户既不知道发生了什么、也不知道停在哪一步；现映射为中文
  （已完成 / 已取消 / 出错中止），未知原因原样透出以便排障。
- **模型调用失败的真实原因不留痕**：`daemon.log` 此前只有启动行，HTTP 状态与上游原文既不落盘
  也不进会话历史，事后完全无法诊断。现失败与重试都会经 `console.error` 写入
  （由 `logFile` 的 tee 落到 `<workspace>/.dsh/logs/daemon.log`）。
- **缺省模型名是个已经弃用的名字，照默认配好 Key 也必然失败**：DeepSeek 已于 2026/07/24 弃用
  `deepseek-chat` / `deepseek-reasoner`（现行官方模型名为 `deepseek-flash`（DeepSeek-V4.1-Flash）
  与 `deepseek-v4-pro`），而 `dsh.model.model` 的缺省值、daemon 的 `DEFAULT_MODEL`、README 配置表、
  `PROTOCOL.md` 与真实联网冒烟的缺省值全都还停在旧名——用户按默认配置第一次请求就会失败，
  且失败原因看起来像是"自己配错了"。现统一改为 `deepseek-flash`（官方 "Your First API Call"
  的首个推荐值，也是官方默认主力档；缺省思考模式已由 daemon 的 `reasoning_content` 投影支持）。
  老配置里的旧名**不会被改写**：它会作为「当前配置」项出现在下拉里并标注出来，等用户自己决定
  何时切换。
- **在大仓库上 grep 一次就能把 daemon「卡到断线」**：`walkFiles` 是**同步**递归，跑在 daemon 的
  事件循环上，而它此前没有任何上限 —— 工作区越大占得越久，期间心跳 ping 发不出去，客户端连续
  3 次未响应即判定链路死亡并重连；用户看到的是「连接断开」，而不是「搜索太慢」，完全无法归因。
  工作区里若存在符号链接环，递归更是永不终止（链接目录的 `isDirectory()` 为真，会被反复跟随）。
  现加入三道上限（条目数 / 递归深度 / 墙钟）与 realpath 去重（同一 canonical 目录只进一次）。
  超限时结果**单独**带一个 `walkExhausted` 而不是复用 `truncated`：结果被裁掉（还有更多匹配）
  与遍历没走完（可能有匹配但没看到）对模型是完全不同的信号，混为一谈会把"没搜完"渲染成"无匹配"，
  模型接着反复换模式重试，把工具预算耗光。
- **回收陈旧 daemon 时可能杀掉无关进程**：升级扩展后，auto 模式探测到的旧构建 daemon 会被回收重启；
  而回收用的 pid 取自 `<workspace>/.dsh/daemon.json` —— 一个**本机任意进程都能写**的文件。
  pid 复用（旧进程已退出、号被别的进程占了）或该文件被篡改时，无条件 `process.kill` 就是杀别人的
  进程，而 `SECURITY.md` 的威胁模型明确把"同机其他进程"算进攻击面。现先读该进程命令行，确认它确实是
  本扩展的 daemon 入口脚本才动手（匹配入口脚本名而非完整路径 —— 陈旧 daemon 恰恰跑在升级前的旧目录里，
  只比完整路径会漏掉它）；读不到命令行（权限不足 / 探针不可用）同样按"身份不明"处理，
  **失败关闭、宁可不杀**，代价只是留一个会自行退出的孤儿进程。
- **外部 daemon 启动命令里的引号与反斜杠被解析错**：`dsh.daemon.command` 模板此前按空白切分并把 `\`
  当转义符，于是 `"C:\Program Files\node.exe"` 会被吃成 `C:ProgramFilesnode.exe` —— 用户配好了也起不来，
  且看不出原因。现改为引号感知解析（单双引号均支持、`""` 这种空参数不丢）、**反斜杠一律不当转义符**
  （Windows 路径里 `\` 是分隔符），未闭合引号按"延续到结尾"宽松处理而不是抛错；注入路径与 token 时
  用函数式替换值，避免路径里恰好出现的 `$&` / `$1` 被当成替换模式而改写。
- **daemon 的 HTTP 端点会自我暴露**：对普通 HTTP 请求回 426 并带 `Upgrade: websocket` 头，等于告诉
  任何本机探测者"这里有个 WebSocket 端点"。现改为 **404 + 空响应体**，不泄漏端点属性。
- **会话只增不减，daemon 跨天长跑内存单调增长**：每个会话常驻 ≤2000 条事件缓冲与补丁快照，
  而 `SessionManager.delete()` 此前**从未被调用过**。现按两条线回收空闲会话（空闲 10 分钟 / 空闲
  会话上限 50，均可在构造时注入便于测试），回收动作挂在**新建会话**的那一刻 —— 不额外加定时器，
  也不依赖调用方记得调。两条**永不回收**的红线：`running` 与 `pending_*`（有在途工具调用或
  等用户决策，删掉就是丢用户的操作）。另有挂起项清扫：到点未响应的条目**先保留**一小会儿
  （此窗口内 respond 必须仍能回 `expired`，前端才知道自己点晚了一步），直到下次登记新条目时才被清掉。
- **迹线步号是全局的，多会话并发时互相污染**：`step` 在 `PROTOCOL.md` 中定义为**会话内**单调递增，
  而实现用一个模块级计数器 —— 两个会话交替跑出来的步号会串成 1、2、1、3、2…。现改为每个会话自持
  一个序列（随会话回收自然归零），协议语义与实现终于一致。
- **Webview 的"静默失败"无从归因**：某条事件渲染时抛错、或收到前端不认识的事件（协议新增了事件而
  前端没跟上），此前都是**彻底静默**的 —— 界面上只表现为"没反应"，没有任何线索能区分"协议漂移"
  与"UI 坏了"。现两种情况都上报诊断（走既有消息通道落到 OutputChannel；只上报，不弹窗、不改产品行为）。
- **上一轮缺失 `message.done` 时，新一轮的回答被续写进上一轮的气泡**：daemon 在流式中崩溃、事件丢失
  或连接中断时，`answerEl` 会一直挂着，下一轮的 `ensureAnswer()` 直接 early-return。现新回合开始前
  强制收尾上一轮 —— 且放在 `resetTurn()` 的**第一行**，后面任何 early-return 都跳不过它。

- **流式输出期间屏幕上是一堆未排版的 Markdown 源码（表格的 `|`、代码围栏、`**`，以及原文里
  被换行折叠挤成一行的 `￥ & ： "` 等符号）**：流式阶段一直是 `textContent += chunk` 写纯文本，
  只有 `message.done` 才做 Markdown 渲染；而 `.message.assistant` 没有 `white-space: pre-wrap`，
  换行被折叠 → 流式期间原文所有标记与结构符号**挤成一行裸文本**，看着像乱码，结束时才"变正常"。
  现改为**流式期间也做正规渲染**（marked + 高亮 + DOMPurify，与最终渲染同一条通路），
  屏幕上从头到尾都是排版好的内容，`message.done` 仍再渲染一次做定妆。
  由于全文渲染的成本随文本线性增长（实测 1.3KB≈16ms、20KB≈160ms 一次），逐帧渲染会吃满 CPU，
  故按体量对渲染间隔线性退避（`src/webview/streamRenderPolicy.js`，≤8KB 每 80ms 一次 ≈12 次/秒，
  上限 1s），使 CPU 占比与文本长度解耦。
- **回答原文改成显式累积，不再从 DOM 回读**：以前 `message.done` 用 `answerBody.textContent`
  取回原文。渲染后 DOM 里只剩剥掉标记的 HTML，回读会把标题/列表/表格/代码块**静默降级成纯段落**
  （复制出来的回答会丢光结构）。现由 `answerRaw` 持有权威原文，渲染与「复制」都以它为准。
- **审批 / 补丁卡决策后不隐藏（"点了没反应"）**：此前 `markApprovalDecided()` 只给卡片加一个
  `.decided` 置灰类、并把按钮 `disabled`，正文（原因 + 完整命令）与三个按钮**全部留在原地**——
  用户点完拒绝/接受/接受并记住，看到的是一排点了没反应的按钮，判断为"选项卡无法隐藏"。现改为
  **决策即折叠**：正文收进 `.card-body` 并隐藏，操作按钮（决策类）一并 `hidden`，只留标题行
  （含「已接受 / 已拒绝 / 已过期 / 已应用」结论徽标）；标题行是开合开关（`▾` 旋转，与「过程」
  时间线同一套隐喻，支持点击 / 回车），随时可再展开回看当时请求了什么命令。补丁卡的「打开 Diff」
  是只读审查入口，标记 `data-keep` 决策后仍保留。补丁从"待审查"到"已应用"之间新增中间态
  「已提交，等待应用」，避免折叠后仍显示误导性的「待审查」。未决策的挂起项（含 surface 重建后
  从 `init.pending` 恢复的）保持展开，折叠只属于已决策的卡片。正文包裹层补齐 flex 间距，
  迁移后不丢原有的段落节奏。
- **界面完全没有样式（根因：样式表被 CSP 拦掉）**：webview 里**脚本靠 nonce 放行、样式只能靠 CSP 的
  URL 匹配放行**，而资源 URI 带百分号编码的盘符路径（形如 `/c%3A/Users/...`）；匹配一旦不成立，
  样式表就被 `default-src 'none'` 整条拦掉，脚本却照常运行 —— 症状是「功能全在、界面退化成浏览器
  默认样式」，极易误判成「改的 CSS 没生效」。现把 CSS 内联进带 nonce 的 `<style>`，不再经过 URL
  匹配，顺带绕开 webview 的资源缓存；CSP 的 `style-src` 收缩为 `'nonce-…' + cspSource`（不带路径）。
  渲染逻辑抽成纯函数（`src/webviewHtml.ts`），且渲染后若残留占位符直接抛错，不再静默退化。
- **模型失败一律提示「请检查 apiKey 与 model 配置」**：上游返回 402 余额不足时，这句与配置无关的
  提示会把用户带向错误的排查方向。现按 HTTP 状态给出确定原因（402 余额不足 / 401 Key 无效 /
  403 无权限 / 404 模型或接口不存在 / 429 限流 / 5xx 上游异常），并从上游 JSON 里取出
  `error.message` 作为佐证，超长正文截断后再展示。
- **`grep` 只做字面量匹配**：模型写多选一（`resolveTarget|assertPathInside`）时一律无匹配，被误判成
  「代码里没有这个符号」而连续重试。现按正则解析，非法正则回退字面量，pattern 超长（>1000）拒绝；
  工具描述与「无匹配」返回值同步写明正则语义。
- **过程时间线默认折叠、失败步骤不再自动展开**：一轮十来步时，展开的过程会把结论顶出好几屏。
  现默认折叠，头部持续显示「N 步 · 耗时 · N 失败」，失败步骤改为行内「失败」徽标 + 计数着色。
- **`scripts/uiPreview.mjs` 自样式内联后跑不通**：面板的样式自检用了裸 `getComputedStyle`，
  而静态预览骨架（jsdom）只挂了 `window` / `document` 等少数全局名 → `ReferenceError` 直接打断
  整支脚本，预览页再也生成不出来。现改走 `window.getComputedStyle`，并新增「已决策卡片折叠态」
  场景（决策由真实点击路径驱动，与线上同源）。

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
