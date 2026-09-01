# Changelog

本项目版本变化遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增

- **原生 function calling**：`ChatModel` 支持 `tools` 参数（ToolDefinition JSON Schema），OpenAI 兼容
  `tool_calls` 与 Anthropic `tool_use` 流式解析（按 index 累积归一为原生 ToolCall）；`realAgent`
  工具 schema 驱动原生调用、fenced 解析兜底，工具结果回灌带调用 id。
- **smokeReal 场景三**：真实连通冒烟新增原生工具探针（给 `chat` 传 `tools`，检查 `result.toolCalls`），
  与场景一（连通，硬断言）/场景二（fenced 探针，软报告）共同覆盖三条链路。

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