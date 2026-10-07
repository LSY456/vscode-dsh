# 贡献指南

欢迎贡献！本仓库是一个将 dsh Agent Daemon 接入 VSCode 的插件工程，遵循开源协作的基本流程：
Fork → 改代码 → 提 PR。

## 开发环境

- Node.js >= 18（20 LTS 推荐）
- npm（或 pnpm / yarn）
- VSCode（用于 Extension Development Host 调试）

## 本地开发

```bash
npm install          # 安装依赖
npm run watch        # 增量构建（扩展宿主 + daemon + webview）
```

在 VSCode 中按 **F5** 启动 Extension Development Host 即可调试扩展。

## 质量门禁（提交 / PR 前必须通过）

```bash
npm run check        # typecheck + build + 单元测试 + 端到端冒烟
npm run package      # VSIX 打包验证（产物见 dist/）
```

- 单元测试：`npm test`（vitest；用例数会持续增长，**不在此处硬编码**，以实际输出为准）。
- 集成测试：`npm run test:integration`（@vscode/test-electron，本机有 VSCode 时复用，否则下载 stable）。
- 冒烟测试：`npm run smoke`（无 VSCode 依赖的真实协议闭环，win / linux 均可跑）。
- 协议第二实现：`npm run smoke:protocol`（用 `examples/python-daemon` 驱动同一份协议，需 Python 3；
  加了第三方依赖或改了协议字段时**必须**跑，它是"后端可换"的唯一证据）。

CI（`.github/workflows/ci.yml`）会在 push / PR 时自动执行同一套门禁。

## 代码规范

- TypeScript `strict` 模式；禁止引入未声明的 any。
- `shared/protocol.ts` 是两端共享的**协议契约**：任何字段修改必须同步
  `PROTOCOL.md` 以及 Extension Host / daemon 两端调用方，并保证向后兼容。
- daemon 逻辑保持"纯逻辑可单测"（如 `sessionManager` / `paths` / `tools`），
  新模块尽量附带 vitest 用例。
- Webview 为 vanilla JS 且受 CSP 约束；新增静态资源需放入 `media/` 并随构建复制。
- 提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)：
  `feat: / fix: / docs: / refactor: / test: / chore:`。

## 分支与发布

- `main` 为默认分支，保持可发布状态。
- 版本号变更请只改 `package.json`（`CHANGELOG.md` 补条目）：daemon 上报的 `daemonVersion`
  由构建时从 `package.json` 注入，`shared/version.ts` 里**没有**手写版本号可改
  （曾经两边各写一份，漂移了 5 个小版本才被发现）。
- **发布身份三处必须是同一个**：`package.json` 的 `publisher`、`repository.url` 的仓库归属、
  以及 Marketplace 上的发布者账号。扩展 ID 是 `<publisher>.<name>`（即 `LSY456.vscode-dsh`），
  **一经发布不可更改** —— 改它等于换一个扩展，已装旧 ID 的用户收不到任何更新。
- 发布时把 `## [Unreleased]` 切成 `## [x.y.z] - YYYY-MM-DD`（Keep a Changelog 格式），
  同一版本内的小节按 **新增 / 变更 / 修复** 各留一个（承接多个迭代周期时需合并重复标题）。
