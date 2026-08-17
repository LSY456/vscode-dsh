# Changelog

本项目版本变化遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

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