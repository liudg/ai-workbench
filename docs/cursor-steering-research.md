# Cursor Agent 运行中引导调研

调研日期：2026-11-06。本机 `agent --version`：`2026.11.05-86047df`。

这里的引导指在当前回合运行中送入追加指令，在安全边界调整当前工作，不取消回合，也不等当前回合结束再开下一轮。

## 结论

| 通道 | 结论 | 证据范围 |
| --- | --- | --- |
| 交互式 CLI | 已有原生 steering 实现；实际启用受本地配置和服务端功能开关控制 | 官方文档、本机安装包实现；本次未做终端交互端到端验证 |
| `agent acp` | 当前版本没有暴露运行中引导；再次 prompt 会取消上一轮 | 本机真实 ACP 会话实测、安装包实现 |
| AI Workbench 当前 Cursor 适配器 | 不能直接开放原生引导 | 使用 ACP，运行中提交返回 Busy |

不能把“Cursor 完全不支持引导”作为结论。准确边界是本机这个版本的 ACP 接口不支持；也不能把取消后续发包装成引导。

## 官方说明

[Cursor Agent overview：Steer a running agent](https://cursor.com/docs/agent/overview#steer-a-running-agent) 说明：交互式 CLI 在运行中按 Enter，会在安全边界送入引导；再次按 Enter 则中断回合。

[Cursor ACP 文档](https://cursor.com/docs/cli/acp) 列出的流程包括 `session/prompt` 和 `session/cancel`，没有列出 steering 方法。文档缺项本身不足以证明不支持，因此继续核查本机实现并实测。

## 本机实现证据

安装目录：`C:/Users/admin/AppData/Local/cursor-agent/versions/2026.11.05-86047df/`。以下模块名取自发布包内 webpack 模块标识，不是推测的仓库路径。

### 交互式 CLI

- `index.js` 中配置默认值包含 `steering: true`。
- `3026.index.js` 的 `./src/ui.tsx` 同时检查配置 `steering` 和服务端功能开关 `agent_context_injection`。
- 运行中追加消息使用 `injectContextAction`，携带 `injectionId`、`expectedRunId`、`userContext`，通过 `submitConversationAction` 送到当前运行。
- 同模块处理 `contextInjectionState` 的 queued、delivered、queuedForNextTurn、cancelled、rejected 等状态；`../agent-core/dist/conversation-actions/steer-outbox.js` 区分确认引导、完成投递和退回待发。
- 这套实现位于交互式 UI 内，不能据此假定 ACP 也提供相同入口。本次未确认当前账号的服务端功能开关是否开启。

### ACP

- `697.index.js` 的 `./src/acp/agent-session.ts`：`handlePrompt` 入口先执行 `this.pendingPromptCancel?.()`，随后建立新的取消上下文并运行 `processPrompt`。旧上下文取消后返回 `stopReason: "cancelled"`。
- 同文件的 `./src/acp/cursor-acp-agent.ts`：`prompt` 转交给 `handlePrompt`；`cancel` 调用当前会话的 `pendingPromptCancel`。`extMethod` 仅处理模型列表扩展，其他扩展请求返回 method-not-found。
- `8096.index.js` 的 ACP SDK 分派代码把 `session/cancel` 通知交给 `cancel`，其余通知需要 Agent 自己提供 `extNotification`；上述 Cursor ACP Agent 未提供该处理器。

## 真实 CLI 验证

使用本机安装包的 `node.exe index.js acp`，与工作台 Windows 启动方式一致。在独立临时目录创建测试会话，使用现有登录状态，切到 ask 模式；提示不调用工具、不读写文件。没有修改应用代码或安装包。

步骤：

1. `initialize` → `authenticate(cursor_login)` → `session/new`。
2. 请求 `session/steer`、`cursor/steer`。
3. `session/set_mode` 切到 ask。
4. 发送第一条 `session/prompt`，要求输出较长的编号列表。
5. 收到第一段实际输出后，在第一条请求尚未返回时，向同一 session 发送第二条 `session/prompt`，要求停止列表并给出短回复。
6. 分别记录两条请求的返回值。

结果（时间为测试进程启动后的毫秒数）：

| 时间 | 操作 / 事件 | 结果 |
| --- | --- | --- |
| 1,341 | initialize | protocolVersion=1；声明 loadSession、图片、MCP、session list 等能力 |
| 21,364 | authenticate | 成功 |
| 45,453 | session/new | 成功 |
| 45,459 | session/steer | `-32601 Method not found` |
| 45,461 | cursor/steer | `-32601 Method not found` |
| 45,463 | 第一条 session/prompt | 开始 |
| 56,306 | 第一条输出 `1`，随后发送第二条 prompt | 第一条尚未结束 |
| 56,317 | 第一条请求返回 | `{"stopReason":"cancelled"}` |
| 73,427 | 第二条开始输出 | 已响应第二条指令；模型拒绝只输出指定标记，改为普通文字回复 |
| 75,931 | 第二条请求返回 | `{"stopReason":"end_turn"}` |

第二条是否遵循固定标记要求不影响协议结论：第一条明确返回 cancelled，属于取消旧回合后处理新提示，而非原回合持续运行的引导。

本次本机复现材料：`%TEMP%/aiwb-cursor-steering-20261106/probe.cjs` 和 `acp-result.json`。临时文件不作为长期仓库依赖。

## 对工作台的影响

- `crates/aiwb-agents/src/cursor/process.rs`：启动 `agent acp`。
- `crates/aiwb-agents/src/cursor/runtime.rs` 的 `Shared::submit`：忙碌时返回 `AgentError::Busy`，没有调用原生注入能力。
- `crates/aiwb-core/src/models/catalog.rs` 的 `AgentCapabilities::cursor()`：`supports_queue: false`，当前不能仅改这个布尔值来开放引导。

继续沿用官方 ACP 接口时，应保留这个能力边界。若产品需要“停止后发送”，应单独定义这种行为，并等待取消收尾后发送，避免并发 prompt 的状态竞争；它不等同于原生引导。

真正的引导接入需要 Cursor 提供相应 ACP 扩展，或另行评估其他正式支持的通道。本次没有验证可替代的公开本地接口；直接依赖交互式 UI 内部的 `injectContextAction` 不具备稳定的接入契约。
