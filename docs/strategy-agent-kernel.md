# 战略决策：真实 Agent 内核怎么定

> 决策日期：2026-09-22　决策依据：`docs/project-review.md` 战略判断 1 + 本次全量核实
> 状态：**已采纳 B+（2026-09-22）** —— 四个动作已全部落地，执行结果见文末第 6 节

---

## 0. 先纠正一个前提

评估报告说「真实 Agent 内核仍缺席」。这个表述**容易被误读成"仓库里没有真内核"**。核实后的准确事实：

| 问题 | 事实 |
| --- | --- |
| 有没有真实内核 | **有。** `src/daemon/realAgent.ts` 是完整的 agent loop：原生 function calling + fenced 兜底解析、工具沙箱、审批门控、补丁 Diff 审查、计划模式（先只读调研出方案、批准后执行）、会话级回滚、可中断请求 + 空闲超时、上下文 token 预算、会话标题生成、脏文档覆盖层 |
| 默认走哪条 | `resolveAgentMode()`（`server.ts:100`）：`auto` 下**配好 Key 就走 real**；显式 `real`/`mock` 优先 |
| 缺的到底是什么 | 缺的是**仓库外的 Cordis 版 dsh daemon**（即"官方内核"）。不是"没有内核" |
| 协议可插拔准备好了吗 | **已就绪**：`dsh.daemon.mode=external` + `dsh.daemon.command`（支持 `{portFile}{workspace}{token}`）+ `dsh.daemon.port/token` |

所以这不是"从零补内核 vs 诚实重定位"，而是：

> **要不要为了对接一个你不拥有、也无法控制演进节奏的外部实现，把项目定位再悬空一段时间。**

---

## 1. 两个选项的真实成本

### A — 补齐 Cordis 版真实 daemon（仓库外）

- **收益**：能自称"官方内核接入"，与 DeepSeek Harness 主线对齐。
- **成本**：**无上界**。要读透 Cordis 的插件 API、维持与上游的协议对齐、承担上游演进的持续跟进成本。
- **前置条件**：你得对 Cordis 的插件接口面有**稳定契约**（能读、能改、有维护路径）。若只是"希望它不会变"，那就不是工程决策而是赌注。
- **致命点**：它依赖仓库外的代码，**你无法在本仓库内验收**。本仓库的 CI 永远测不到它。

### B+ — 承认 `realAgent` 就是内核，把协议当扩展点（推荐）

- **收益**：立刻兑现评估报告点出的三处护城河（daemon 解耦 / 原生 Diff 审查 / 上下文捕获）—— 这三条**全在前端侧**，B+ 完全兑现。
- **成本**：**1–2 天**（文档 + 默认路径 + 一个协议第二实现样例），不是报告里说的 1–2 个月。
- **关键**：**不锁死 A**。`external` 通道已经在了，将来想接 Cordis 随时可接，不需要现在做取舍。

> 报告 §3.1 / 判断 3 自己给出的结论是"护城河在 daemon 解耦、原生 Diff、上下文捕获"，并建议"不要为了方便去新增第二套前端"。同一逻辑：**不要再为对接一个外部实现而让定位悬空。**

---

## 2. 推荐：B+，具体动作清单

### 动作 1（半天）README 重写“三层定位”

现在的 README 是从**协议**讲起的（`README.md:1-13` 开篇即"dsh 作为底层 Agent Daemon 运行时（基于 Cordis 元框架）"），把"这是一个自带内核、开箱可用的前端"这件事藏在了配置项里。改成：

1. **第一层**：开箱可用的 VSCode 本地 Agent（自带内核，配 Key 即用）；
2. **第二层**：开放协议 + 参考实现，第三方内核可接入（`external` 模式）；
3. **第三层**：mock agent 仅用于测试与离线演示。

### 动作 2（半天）消除「静默降级成 mock」

这是当前**最误导用户**的地方：没配 Key 时不报错、不提示，直接静默走 mock 关键字循环，用户以为在用真模型。
→ 未配 Key 时在面板显著提示"当前为演示模式（未配置模型 Key）"，并给出配置入口。

### 动作 3（半天）给协议补一个「第二实现」证据

报告 §1.2 的【判断】点得准：协议的"前端可换、后端可换"目前**只有文档承诺，没有第二实现来证明**。
→ 写一个 ~150 行的 CLI 参考 daemon（换一门语言更好，比如 Python），只实现 `initialize` + `session.create` + `session.send` + 一个 `read_file` 工具。它同时是：
- 协议可插拔的**可验证证据**；
- 一个真实可跑的集成测试（本仓库 CI 能测到它，正好补上 A 的致命点）。

### 动作 4 文档纠偏

- `README.md:23` 的「会话可跨窗口存活」→ 按战略判断 2 改成准确表述（daemon 由扩展宿主 `spawn`、随 `deactivate()` 被 kill）。
- `README.md:13` 的「真实 daemon 只需实现同一协议即可无缝替换」→ 改成可验证的表述（协议 + 第二实现样例已提供）。
- `README.md:116-119` 的 mock「咒语」教学（`（write edit）`/`（danger）`/`（slow）`）→ 从主路径移到 `docs/` 或测试说明。
- `SECURITY.md` 版本矩阵仍是 0.3.x/0.2.x，实际已是 0.4.0。
- `docs/project-review.md:293` 的实测数字「18 文件 / 244 用例」→ 现为 **21 文件 / 317 用例**。

---

## 3. 什么情况下应该改选 A

只有当下列条件**同时**成立，A 才值得投入：

1. 你能拿到 **Cordis 插件 API 的稳定契约**（不是"应该差不多"，而是明确的接口面与版本承诺）；
2. 你有一条**维护路径**（能提 PR、能跟进 breaking change，或有维护者协同）；
3. 或者你的**真实目标**就是"成为 dsh 的官方前端"——那 A 是唯一路径，B+ 只是它的前置。

任一条件不成立 → **先做 B+**，把 A 当作一扇随时可开的门。

---

## 4. 验收标准

| 动作 | 验收 |
| --- | --- |
| 1 README 重写 | 新用户读完 30 秒内能答出"这是个自带内核、配 Key 就能用的 VSCode Agent" |
| 2 消除静默降级 | 无 Key 启动 → 面板出现"演示模式"提示；面板显示当前 agent 模式（mock/real） |
| 3 第二实现样例 | `npm run smoke:protocol`（或等价命令）能拉起该 CLI daemon 并跑通一轮 `session.send` |
| 4 文档纠偏 | 陈旧版本号（`SECURITY.md` 0.3.x）与定位表述（"无缝替换""跨窗口存活"）已改；**实测数字改为"标注快照"而非删除**——历史测量是事实，抹掉它等于伪造，故保留原值并就地补注当前值 |

---

## 5. 与后续 P2 项的关系（B+ 之后）

`realAgent` 既然是一等公民，P2 的优先级应据此重排：

1. ~~**会话级事务回滚**（P2-6）—— 与现有 Diff 审批天然互补（事前拦截 + 事后兜底），成本低、感知强。~~ **【2026-10-08 已实现】** 口径见 `docs/project-review.md` 的「会话回滚追记」。
2. ~~**Plan 模式**（P2-7）—— 复用现有审批基础设施，代价小。~~ **【2026-10-09 已实现】** —— 它确实建立在那套挂起—恢复设施上（`waitForUser` / `expiresAt` / 断线续跑 / 取消），**没有引入第二套等待语义**；真正需要自己拍板的是"只读承诺落在工具清单层而非提示词层"与"调研轮次独立预算"。口径见同一文档的「Plan 模式追记」。
3. ~~**MCP 客户端**（P2-5）—— 从"自研 Agent"升级为"Agent 平台"的关键，但工作量最大，放其后。~~
   **【2026-10-01 追记：已决策不接入 MCP。】** 理由：本项目是**工作区内的编码 agent**，
   `bash_execute`（带审批）已能触达本机可达的目标系统 —— "查询数据库 / 读日志文件"这两个
   最常被举的场景用 CLI 就能做，MCP 边际收益低；而 MCP server 会**绕开路径沙箱 / 命令策略 /
   审批三道门**（它自己决定权限边界，daemon 无法裁决），安全叙事会从强变弱。
   **重新评估的判据**：目标系统 shell 不可达（SaaS / 内部 API / 需 OAuth 的受管云服务）、
   或"每条只读查询都要点审批"成为真实痛点。口径以 `docs/project-review.md` 的「MCP 追记」为准。
4. **图片输入**（P2-4）—— 高频刚需，独立于上述。

---

## 6. 执行结果（2026-09-22，B+ 已落地）

### 动作 1 + 4：文档重定位与纠偏

- `README.md` 开篇改为**三层定位表**（开箱可用内核 / 开放协议 + 参考实现 / mock 仅测试夹具），
  并补一句"缺失 Key 时会显示演示模式横幅"——把产品事实写在第一屏。
- 纠正两处失实表述：
  - 「会话可跨窗口存活」→ 改为"daemon 由扩展宿主 `spawn`、`deactivate()` 时回收，**不跨窗口存活**；
    但同工作区多窗口可复用同一 daemon（连接级隔离）"，并在「已知局限」补完整生命周期说明。
  - 「真实 daemon 只需实现同一协议即可无缝替换」→ 改为可验证表述，指向真实存在的第二实现。
- mock「咒语」教学移出 README 主路径 → 新建 [mock-agent.md](mock-agent.md)（含关键字表与源码索引）。
- `SECURITY.md` 版本矩阵 0.3.x → 0.4.x；`CONTRIBUTING.md` 去掉硬编码用例数并补 `smoke:protocol` 门禁。
- `docs/project-review.md` 顶部加**追记**：战略判断 1 已被复核推翻并指向本文；实测数字就地标注快照，
  保留原值（历史测量是事实，不应抹除）。

### 动作 2：消除静默降级成 mock

- 协议：`InitializeResult` 新增可选字段 **`agentReason: 'no-api-key' | 'forced-mock'`**
  （向后兼容，老客户端忽略即可）；daemon 端抽出 `resolveAgentDecision()`，
  `resolveAgentMode()` 改为它的薄封装，保证两者不会漂移。
- 扩展侧：`AgentInfo` 带上 `agentReason`；`DaemonManager.onAgentInfo()` 在**每次握手成功后**推送，
  `webviewPanel` 转发为本地事件 `agent.info`——这样"配好 Key → 重启 daemon"能真正**撤下**横幅。
- 面板：新增常驻**「演示模式」横幅**（警示色 + 成因文案 + 「配置模型」直通设置面板）；
  模式 chip 改中文（`演示模式` / `真实模型`）并在 mock 时着警示色。
- 顺带清理：mock 专属入口（`（danger）` 演示审批）在真实模型下**隐藏**；
  「修改 TODO」建议项在真实模型下自动改用无咒语的自然语言版本。
- 测试：`server.test.ts` 新增 4 例（成因区分 / 与 `resolveAgentMode` 同源）、
  `src/webview/panel.test.js` 新增 6 例（横幅出现与撤下、成因文案、一键配置、咒语切换），
  并修正原先断言 `'real · deepseek-chat'` 的用例。**317 例全通过。**

### 动作 3：第二实现（protocol 可插拔的证据）

- 新增 `examples/python-daemon/dsh_daemon.py`：Python 3 + **仅标准库**，WebSocket 服务端手写
  （RFC 6455 子集：文本帧/掩码/ping-pong/close），实现 `initialize` / `session.create` /
  `session.send` / `session.cancel` / `ping` / `shutdown` + 一个 `read_file` 工具。
- 新增 `scripts/smokeProtocol.js`（`npm run smoke:protocol`）：拉起该 daemon 并走完整轮对话，
  18 项断言覆盖端口上报、**握手鉴权（错 token / 带 Origin 均拒绝）**、事件时序、
  `read_file` 路径护栏、错误码、`shutdown` 真退进程。缺 Python 3 优雅跳过，`-- --require` 则判失败。
- CI：`test` job 加 `actions/setup-python@v5` 与 `npm run smoke:protocol -- --require`
  （win/ubuntu 双平台），明确**禁止静默跳过**。
- `PROTOCOL.md` 新增 §9 说明第二实现，并成为"任何新实现照着跑通即为兼容"的可执行规格。

### 额外发现并修复：`[hidden]` 被 `display: flex` 覆盖

排查横幅样式时发现 `media/webview.css` 的 `.sheet`（覆盖式设置/历史面板）与 `.pending-bar`
自带了 `display: flex`，而**作者样式里的 `display` 会覆盖 UA 样式表的 `[hidden]{display:none}`**
（同特异性下作者来源优先）——即 `hidden` 属性在这些元素上可能失效，面板会常显。
已在样式表顶部补全局兜底 `[hidden] { display: none !important; }` 并注明原因。
（该缺陷来自在途未验证的「Webview 观感重做」，此前没有被任何自动化测试覆盖——
面板 DOM 测试断言的是 `element.hidden` 属性而非计算样式，因此测不出这类问题。）
