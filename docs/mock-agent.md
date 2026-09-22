# mock agent：关键字驱动行为表

> 这份文档**只对不上真实模型时**有意义。配好模型 Key 后走的是 `realAgent`（原生 function calling），
> 下面这些关键字**不会**被解析成特殊语义——它们只是普通的提示词。

## 它是什么

`mock` 是仓库内置的**模拟 Agent**，行为由 prompt 里的关键字决定，完全确定性、不联网。
它的用途是**测试与离线演示**：协议、审批、补丁、续跑、取消这些链路必须能在没有模型、没有网络的情况下
端到端跑通，否则它们就只能在"模型恰好这么回答"时被验证。

所以 mock 是**测试夹具**，不是产品卖点。没配模型 Key 时面板顶部会显示「演示模式」横幅，
明确告诉你当前回复不是真实模型的输出（`agentReason=no-api-key`）。

## 关键字表

| 关键字（正则，忽略大小写） | 触发行为 | 相关事件 |
| --- | --- | --- |
| `read` / `查看` / `读取`（**且**本次已捕获到附件） | 朗读本次上下文的附件内容 | `tool.started` / `tool.executed` |
| `修改` / `edit` / `write` / `创建` / `replace` | 生成一个补丁提案，走**原生 Diff 审查** | `file.patch.pending` → 用户决策 → `file.patch.result` |
| `bash` / `danger` / `危险` / `rm ` | 触发**高危工具审批**卡 | `approval.request` → 用户决策 → `tool.executed` |
| `slow` / `慢` | 慢速流式输出（便于验证**取消**与流式中断） | `message.delta` × N，`session.cancel` → `session.ended(canceled)` |
| （以上都不命中） | 兜底回显：说明这是参考 daemon 的演示输出 | `message.delta` / `message.done` |

路径解析：prompt 里出现绝对路径则原样使用；只给文件名/相对路径则解析到工作区内
（找不到则兜底到工作区根下的新文件）。所有路径仍受**路径护栏**约束——越界一律拒绝。

> 兜底回复的末尾会带上 `（参考 daemon 演示输出，非真实模型结果）`，源码里也刻意保留了
> `edited by dsh mock agent` 之类的签名，避免演示产物被误当成真实产出。

## 在哪用

- **面板里手动试**：面板空态有一个 `演示 高危工具审批流程（仅演示模式）` 的快捷项，
  它**只在演示模式下出现**——真实模型下这个入口会隐藏，mock 的「咒语」语法不该教给正常使用的用户。
- **冒烟测试**：`scripts/smoke.js` 大量依赖这些关键字构造确定性的审批 / 补丁 / 取消场景。
- **真实 Agent 的对照**：`npm run smoke` 里用 `--agent real --fake-model` 跑同一批场景，
  确保"真实内核"与"夹具"在**协议层**产生相同的时序。

## 相关源码

| 文件 | 作用 |
| --- | --- |
| `src/daemon/agent.ts` | mock 循环本体（关键词判定 + 事件时序） |
| `src/daemon/realAgent.ts` | 真实内核（与 mock 共用 `AgentContext` 契约） |
| `src/daemon/server.ts` | `resolveAgentDecision()`：决定走哪条，并回报 `agentReason` |
| `scripts/smoke.js` | 用这些关键字构造端到端场景 |
