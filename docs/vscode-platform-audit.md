# vscode-dsh 平台一致性 & 产品化体检

> 日期：2026-09-25 · 对应版本：0.4.7 · 范围：**VS Code 平台契约 + 可用性 + Marketplace 产品化**
>
> 与 [`project-review.md`](project-review.md) 的分工：那份评的是**架构 / 正确性 / 安全**（其 P0-1~P0-4 已全部落地），
> 本文评的是**"作为一个能在 Marketplace 上被别人装上就用"的 VS Code 插件，还差什么**。
> 结论以代码与实测为准，判断项已标注【判断】。
>
> **实施状态（2026-09-25 同日更新）**：Batch A 的改动清单 4 项已全部落地 —— P0-1 见 `e1dad7e`（0.5.0），
> P0-2 / P0-3 / P2-3 见 0.5.1。**未做**：验收里提到的集成测试 T6（Restricted Mode）——它需要再起一个
> **不带** `--disable-workspace-trust` 的 Extension Host 进程（现有 `scripts/runIntegrationTests.js`
> 固定传该参数以保证 T1~T5 的 `isTrusted === true`），本机无法验证，留待有 CI 环境时补。
> Batch B / C 未动。

---

## 0. 一句话结论

内核、安全、工程化的地基已经超出同类插件水平；**现在缺的不是功能，而是两层"平台礼貌"** ——
**VS Code 平台契约**（信任 / Remote / 设置作用域 / 生命周期）和 **Marketplace 产品化**（元数据 / 截图 / 发布）。
其中 **P0 三条属安全与正确性，建议先修**；P1/P2 可分批推进，彼此不阻塞。

---

## 1. 核查方法与证据

- **读**：`package.json`（全文）、`src/extension.ts`（全文）、`src/daemonManager.ts`（spawn / 工作区根 / dispose）、
  `src/webviewPanel.ts`（webview 选项）、`src/configAccessor.ts`、`src/daemon/logFile.ts`、
  `src/daemon/trajectoryStore.ts`、`src/daemon/sessionManager.ts`、`.vscodeignore`、`.gitignore`、
  `.github/workflows/*.yml`、`README.md`、`docs/*`
- **跑**：`vsce ls`（真实打包清单，不是推测）、全仓 grep 关键平台 API
  （`workspace.isTrusted` / `SecretStorage` / `extensionKind` / `createOutputChannel` / 体积上限相关）

---

## 2. 已经达标的：**这些不要动**

明确列出来，避免后续"优化"把它们改坏：

1. **凭据安全化 A4**：`apiKey` 走 SecretStorage，旧明文自动回迁并清除（`src/configAccessor.ts` + 单测覆盖）——
   多数同类插件至今仍是明文 `settings.json`。
2. **Webview 安全三层**：CSP + nonce（脚本）、样式内联、DOMPurify 净化；脚本资源 URI 带内容指纹。
3. **CI 四段 + 发布流**：`npm audit --omit=dev`（高危阻断）+ OSV-Scanner、双 OS 测试矩阵、
   真实扩展宿主集成测试（xvfb）、main 打包 artifact、tag 触发 GitHub Release。
4. **体积自守**：日志轮转（`logFile.maxBytes`）、轨迹 5MB 轮转、`.dsh` 0600 权限；
   `vsce ls` 实测 VSIX 仅 37 文件 / ~230 KB，`node_modules` 只带了 `ws`（必需）。
5. **测试基线**：25 文件 / 381 例单测 + 端到端冒烟 + 协议"第二实现"冒烟（Python 标准库 daemon）。
6. `.vscodeignore` 精简、`vscode:prepublish` 挂钩、README/CHANGELOG/LICENSE 由 vsce 强制保留（实测在包内）。

---

## 3. 缺口清单

### P0 —— 安全 / 正确性，建议立即修

#### P0-1　工作区信任未参与任何决策：打开不可信仓库即可执行任意进程 🔴

**证据链（三段拼起来才成立）**

1. 全仓**没有** `vscode.workspace.isTrusted`（grep 命中的 `isTrusted` 全是 daemon 侧的"命令免审批白名单"，见 `src/daemon/server.ts:412`）；
   `package.json` 里**没有** `capabilities` 字段。
2. `dsh.daemon.command`（`package.json:153-157`）在 **auto（默认）模式**下被当作可执行文件路径直接 `cp.spawn`
   （`src/daemonManager.ts:330-334` → `:404-423`）。
3. 它是个 `window` 作用域的普通设置 → **工作区设置可覆盖**；而 `activate()` 末尾无条件 `void daemon.start()`（`src/extension.ts:145`）。

**攻击面**：仓库里放一份 `.vscode/settings.json`，用户点开 dsh 视图 → 任意进程在本机执行。
同类向量还有 `dsh.capabilities.allowedTools`（放开 bash 工具白名单）、`dsh.model.baseURL`（把用户 Key 引到攻击者端点）。

**修法（三件要一起做，缺一件仍可绕过）**

1. 声明能力：
   ```jsonc
   "capabilities": {
     "untrustedWorkspaces": {
       "supported": "limited",
       "restrictedConfigurations": [
         "dsh.daemon.command", "dsh.daemon.mode", "dsh.daemon.token",
         "dsh.capabilities.allowedTools", "dsh.model.baseURL"
       ]
     },
     "virtualWorkspaces": { "supported": false }
   }
   ```
2. 把会执行代码的设置钉死为机器作用域：`dsh.daemon.command` 等加 `"scope": "machine"`
   （machine 作用域**不可被工作区设置覆盖**，这正是 VS Code 对"会执行代码的设置"的官方建议）。
3. `activate()` 加信任门：`!vscode.workspace.isTrusted` 时**不启动 daemon**，状态栏显示"受限模式"，
   面板顶部给一条横幅 + 一键打开信任管理（与现有"演示模式"横幅同一套 UI 机制）。

**验收**：单测（注入假 `isTrusted: false` → 断言不 spawn）；集成测试加 T6「Restricted Mode 下激活不拉起 daemon」。

#### P0-2　没打开文件夹时，工作区根回落到 `process.cwd()`

**证据**：`src/daemonManager.ts:503-509` —— 无 `workspaceFolders` 时 `return vscode.workspace.rootPath ?? process.cwd()`。
于是 daemon 的根 = **扩展宿主的 cwd**（VS Code 安装目录或用户主目录）：端口文件、`.dsh/` 落在那儿，
而路径护栏的 root 也取自这里（`assertPathInside`）——即"Agent 的工作区"是一个与用户意图无关的目录。

**修法**：显式拒绝启动（状态置 `disabled` + 明确文案"请先打开一个文件夹再使用 dsh"），而不是猜一个根。
顺带把 `vscode.workspace.rootPath`（已废弃 API）一并去掉。

**附带【判断】**：multi-root 下只取 `workspaceFolders[0]`（`daemonManager:506`、`contextCapture.ts:143`、`webviewPanel.ts:218`）。
单根语义清晰、不必重设计，但**建议显式化**：新增 `dsh.workspace.root`（空 = 取第一个根），或首次多根时提示"Agent 只作用于 `<folder>`"。

#### P0-3　`.dsh/` 没有自守 `.gitignore`：会话历史与轨迹含代码片段，会被误提交

**证据**：全仓 grep `gitignore` **无任何命中** —— 插件不会为 `.dsh/` 写忽略规则。
仓库根 `.gitignore` 里的 `.dsh/` 只保护**本仓库**；在用户的工作区里，`.dsh/history.json`（对话全文）、
`.dsh/trajectory/*.jsonl`（工具输入输出）、`.dsh/logs/daemon.log`、`.dsh/trust.json` 会直接出现在 `git status`。

**影响**：轻则刷出一堆未跟踪文件（VS Code 资源管理器里很脏），重则用户 `git add -A` 把**含业务代码与对话内容的记录**提交进公司仓库。

**修法**：daemon 首次创建 `.dsh/` 时写一份 `.gitignore`（内容 `*`），`docs/` 里说明；
单测断言"建目录后该文件存在且包含 `*`"。注意本仓库自身的 `.dsh/` 已在根 `.gitignore` 中，互不影响。

---

### P1 —— 平台正确性 / 一致性

#### P1-1　`extensionKind` 未声明 → Remote 场景跑错侧

`package.json` 无 `extensionKind`。daemon 是 `spawn` 在**扩展宿主侧**、根取自 `workspaceFolders[0].uri.fsPath`：
若宿主在 UI 侧（本地）而工作区在远端（Remote-SSH / WSL / Dev Containers），路径与进程语义全错。
**修法**：`"extensionKind": ["workspace"]`，并在 README 写清；与路线图 **P4a 实测**一起验收（不要只声明不验证）。

#### P1-2　`dsh.apiKey` 仍是 `contributes.configuration` 里的明文属性（契约自相矛盾）

`package.json:168-172` 仍在教用户往 `settings.json` 写明文 Key，且描述"daemon 端可忽略"已经过时；
而实现侧（`src/configAccessor.ts`）是"读 SecretStorage 优先、写只写 SecretStorage"。
**修法**：给该属性加 `deprecationMessage`（保留 key 以兼容旧配置的一次性迁移），或直接删除属性；
`dsh.daemon.token`（external 模式握手令牌）同理，建议一并走 SecretStorage。

#### P1-3　面向用户的英文枚举直接暴露（与你们刚修的 `session.ended` 同类）

`src/extension.ts:73` 状态栏文案 `dsh: ${info.status}`，`:119` / `:126` 通知里同样直接拼 `s.status` / `s.detail` →
界面上会出现 `dsh: connected`、`dsh daemon 状态: connecting` 这类内部枚举。
面板里已有一份中文映射（`media/webview.js` 的 `STATUS_LABEL`）。
**修法**：把状态标签提为共享模块（如 `src/statusLabel.ts`），扩展侧与 webview 共用；状态栏只显示
"已连接 / 连接中 / 出错中止"，排障细节留在 tooltip 与 OutputChannel。

#### P1-4　历史体积无上限

`trajectoryStore`（5MB 轮转）与 `logFile`（`maxBytes`）都有上限，但 `.dsh/history.json` 与扩展侧
workspaceState 历史**未见任何保留策略**（grep 无 retention / prune / maxSessions）。
长期使用后文件线性膨胀：面板"历史"列表变慢、`init` 负载与内存同步变大。
**修法**：`dsh.history.maxSessions`（缺省 50，0 = 不限），落盘与读取时按 `createdAt` 修剪；
单测：写入 60 条 → 文件内 50 条且保留最新。

---

### P2 —— 好用 / 产品化打磨

| # | 项 | 证据 / 说明 | 修法 |
|---|---|---|---|
| P2-1 | 命令元数据不规范 | 标题手写 `"dsh: 打开 Agent 面板"`；`dsh.debug.captureContext` 出现在命令面板；`dsh.diff.*` 无补丁时点了没反应 | 拆成 `"category": "dsh"` + 纯标题；`menus.commandPalette` 用 `when:false` / `when: resourceScheme == dsh-patch` 收敛 |
| P2-2 | 无默认快捷键 | `package.json` 无 `keybindings` | `dsh.openPanel`（如 `Ctrl+Alt+D`）、`dsh.sendSelection`（`Ctrl+Alt+K`，`when: editorTextFocus`） |
| P2-3 | **调试命令每次点击新建 OutputChannel 且从不 dispose** | `src/extension.ts:134` 在命令回调里 `createOutputChannel` | `activate` 里建一次 + `subscriptions.push`（真实小泄漏） |
| P2-4 | Marketplace 元数据缺失 | 无 `icon`（需 128×128 PNG，`resources/dsh-activity.svg` 不能当图标）、无 `keywords`、`categories` 无 `AI`；README **无徽章无截图**（`scripts/ui-preview*.png` 被 gitignore 排除）；`release.yml` 只发 GitHub Release，**没有 Marketplace 发布** | 补元数据；精选截图放 `docs/images/`，README 用 raw.githubusercontent **绝对**链接（Marketplace 不解析相对路径）；release 加 `vsce publish -p $VSCE_PAT` |
| P2-5 | i18n 缺失 | `package.json` 内中文串硬编码；运行时字符串无 `vscode.l10n.t()` | **只做一半**：`package.nls.json`（英文为默认）+ `package.nls.zh-cn.json`，把 `package.json` 里的中文串换成 `%key%`。收益/成本比最高；webview 文案暂不动 |
| P2-6 | lint / format 基建缺失 | 无 eslint / prettier / .editorconfig，而代码里留着**失效的** `// eslint-disable-next-line no-undef`（`media/webview.js:17`） | `eslint.config.mjs`（flat + `@typescript-eslint`）+ prettier + `.editorconfig`，`npm run lint` 接进 CI |
| P2-7 | `retainContextWhenHidden: true` | `src/webviewPanel.ts:171,249`；你们**已经**实现 `init` 快照 + 事件重放，保留整棵 DOM 是"内存换体验"的旧做法（VS Code 官方亦提醒其昂贵） | 关掉并依赖重放恢复；**需实测**滚动位置与输入草稿的观感代价后再定【判断】 |
| P2-8 | 打包规则用逐文件排除 | `.vscodeignore` 逐条列 `docs/xxx.md` → 新增文档会自动进包；`examples/python-daemon/dsh_daemon.py` 目前**在包内**（`vsce ls` 实测），是否有意为之需决定 | 改 `docs/**` 通配；`examples/**` 二选一（进包=第二实现的活文档，不进=更瘦） |

---

## 4. 开发方案（三批，彼此独立、可分别发版）

### Batch A —— 安全与正确性（建议立刻，1 个版本）

**改动清单**

1. `package.json`：加 `capabilities`（信任/虚拟工作区）+ 给 `daemon.command` 等加 `"scope": "machine"`（P0-1）
2. `src/extension.ts`：信任门（未信任不启动 daemon + 明确提示）；调试命令的 OutputChannel 改为注册期创建（P0-1、P2-3）
3. `src/daemonManager.ts`：无工作区时显式拒绝启动，去掉废弃的 `rootPath`（P0-2）
4. daemon 侧：首次创建 `.dsh/` 时写 `.gitignore`（P0-3）

**验收**：`typecheck` → 单测新增（信任门 3 例 / 无工作区 2 例 / `.dsh/.gitignore` 1 例）→ `build` → `smoke`
→ 集成测试加 T6（Restricted Mode）。版本 0.4.7 → **0.5.0**（行为有变，值得跨 minor）。

### Batch B —— 平台一致性（可与路线图 P4a 合并）

1. `extensionKind: ["workspace"]` + README 说明（P1-1）
2. `dsh.apiKey` / `dsh.daemon.token` 的配置项契约收敛（P1-2）
3. `src/statusLabel.ts` 共享状态文案，状态栏与通知改中文（P1-3）
4. `dsh.history.maxSessions` + 修剪逻辑 + 单测（P1-4）
5. **P4a 真实 Remote 实测**（WSL / Dev Containers 至少各一次），把结论写进 README「已知局限」

**验收**：`check` 全绿 + 真机 Remote 手工清单（打开远端工作区 → 面板连接 → 读文件 → 补丁落盘 → 路径护栏）。

### Batch C —— 产品化打磨（面向"别人能装上就用"）

1. 命令元数据 + `menus.commandPalette` + 默认快捷键（P2-1、P2-2）
2. lint/format 基建接进 CI（P2-6）
3. Marketplace 元数据 + 截图 + `vsce publish` 步骤（P2-4）
4. `package.nls.json` / `package.nls.zh-cn.json`（P2-5，只做 package.json 的一半）
5. `retainContextWhenHidden` 实测后决策（P2-7）、`.vscodeignore` 通配（P2-8）

**验收**：`vsce ls` 体积不回升；Marketplace 预览页（`vsce package` + 本地装 VSIX）能正确显示图标/README/截图。

---

## 5. 不建议做的事（避免走弯路）

- **不加 telemetry**：与 `SECURITY.md` 的"不采集"承诺冲突，且对本地 Agent 场景没有必要性。
- **不为 i18n 全量重构 webview 文案**：收益主要在市场列表页，`package.nls` 那一半就够。
- **不在没有真实 Remote 环境时"猜着改"路径逻辑**：先声明 `extensionKind` + 实测（Batch B 第 5 条），再谈适配。
- **不做 multi-root 的"同时服务多个根"重设计**：当前单根语义清晰，第一版只需把它**显式化**。
- **不为覆盖率拆现有模块**、不换打包器（esbuild 已够，webpack 只会让 `out/` 变复杂）。

---

## 6. 优先级矩阵

| 项 | 影响 | 成本 | 建议批次 |
|---|---|---|---|
| P0-1 信任门 + 设置作用域 | 高（RCE 面） | 小（~半天） | A |
| P0-3 `.dsh/.gitignore` | 中高（数据外泄） | 极小（~1 小时） | A |
| P0-2 无工作区回落 cwd | 中（错误行为） | 小 | A |
| P1-1 `extensionKind` | 高（Remote 全错） | 极小（声明）+ 实测 | B |
| P1-4 历史保留策略 | 中（长期可用性） | 小 | B |
| P1-3 状态文案一致 | 中低（观感） | 小 | B |
| P2-3 OutputChannel 泄漏 | 低 | 极小 | A（顺手） |
| P2-4 Marketplace 元数据 | 高（能不能被装上） | 中 | C |
| P2-6 lint 基建 | 中（长期质量） | 中 | C |
| P2-1/2 命令与快捷键 | 中低 | 小 | C |

---

## 7. 本次核查的实测记录

- `vsce ls` 实际输出（节选）：包内含 `README.md / CHANGELOG.md / LICENSE / SECURITY.md / package.json /
  resources/dsh-activity.svg / out/**（extension + media + daemon）/ docs/mock-agent.md /
  examples/python-daemon/dsh_daemon.py / node_modules/ws/**` → 印证 P2-8 的两个决定项。
- `grep -rn "workspace.isTrusted"` → **0 命中**（P0-1 前提成立）。
- `grep -rn "gitignore" src/ shared/ scripts/` → **0 命中**（P0-3 前提成立）。
- `grep -n "maxBytes|rotate" src/daemon/logFile.ts src/daemon/trajectoryStore.ts` → 均命中；
  `sessionManager.ts` 无上限相关命中（P1-4 前提成立）。
- `grep -n "retainContextWhenHidden|localResourceRoots|enableScripts" src/webviewPanel.ts` → 171/249 行 `true`（P2-7）。
- `grep -n "createOutputChannel" src/extension.ts src/logger.ts` → `extension.ts:134`（命令内、未 dispose）+ `logger.ts:13`（正确示例）。
- 根目录无 `eslint*` / `.prettierrc*` / `.editorconfig`（P2-6 前提成立）。
- `README.md` 无任何 `![`（无截图/徽章）；`scripts/ui-preview*.png` 已被 `.gitignore` 排除（P2-4）。

---

**下一步**：先确认 Batch A 是否按本文方案执行（尤其 P0-1 的第 3 条会给"未信任工作区"加一道启动门，
属于**用户可见的行为变化**），确认后我按 Batch A 逐项落地 + 补测试 + 跑完整验证链。
