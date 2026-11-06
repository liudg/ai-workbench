# 嵌套会话

## 已实现

**接入**
- daemon 在 `/mcp` 提供 MCP Streamable HTTP，只听回环地址，和 `/ws` 共用端口，用 `rmcp`，无状态。代码在 `crates/aiwb-daemon/src/mcp/`，规则和数据在 `services/subtasks.rs`。出处：t3code `apps/server/src/mcp/McpHttpServer.ts`。
- 每次拉起 Agent 进程发一个 token，内存里存哈希，会话停止时撤销，daemon 重启后 resume 时重发（`mcp/tokens.rs`）。出处：t3code `McpSessionRegistry.ts`。
- 所有任务都有工作台 MCP：项目里的、独立聊天和嵌套会话一样；侧边聊天没有。
- 注入方式，出处 t3code `CodexAdapterV2.ts`、`ClaudeAdapterV2.ts`：
  - Codex：`thread/start` 和 resume 的 `config` 加 `mcp_servers.aiwb`，不影响用户配的 MCP。
  - Claude：`--mcp-config` 加 `--allowedTools mcp__aiwb__*` 免审批。
  - Cursor：`session/new`、`session/load` 的 `mcpServers` 传 ACP `McpServerHttp`；`aiwb: aiwb_*` 的审批替用户选「允许一次」。
- 使用说明（`WorkbenchMcp::INSTRUCTIONS`）跟着 MCP 一起给：Codex 放进 `turn/start.additionalContext`，Claude 用 `--append-system-prompt`，Cursor 放在进程第一条提示前。「嵌套、另开、后台」或点名别的 Agent 时用工作台工具，「子 Agent」「并行」用自带的。出处：t3code `orchestrationInstructions.ts`、`CodexDeveloperInstructions.ts`。

**工具**：只能动调用方自己的直接子任务。

| 工具 | 做什么 | 出处 |
|---|---|---|
| `aiwb_capabilities` | 能用的 Agent、模型目录和调用方自己的设置 | t3code `orchestrator_capabilities` |
| `aiwb_subtask_create` | 开一个或一批，立刻返回 | Claude Code 嵌套会话、t3code `delegate_task` |
| `aiwb_subtask_list` | 标题、Agent、状态、预览、分支 | t3code `task_status` |
| `aiwb_subtask_read` | 分页读时间线 | t3code `t3_thread_read` |
| `aiwb_subtask_send` | 追加消息，`mode` 取 `auto` 或 `steer` | t3code `t3_thread_send` |
| `aiwb_subtask_interrupt` | 打断回合 | t3code `task_cancel` |

**用户同意**：`initiation` 由 Agent 声明，出处 Claude Code 桌面版嵌套会话。

| `initiation` | 什么时候用 | 怎么开 |
|---|---|---|
| `user_asked` | 用户原话要求另开、后台跑或现在就开 | 直接开 |
| `offer` | 用户点了要做的事，没说要另开 | 出卡片，Agent 等用户选 |
| `own_initiative` | Agent 自己提议 | 只出卡片，Agent 不等；一回合最多 3 张，一周过期 |

**父子关系**
- 任务带 `parentTaskId`，和父任务同一个项目，层数不限。
- 独立聊天开的子任务用聊天自己的文件夹，删子任务不动这个文件夹。
- 父子关系挂在任务上，换过 Agent 时回报投给父任务现在用的会话。
- 首条消息要能单独看懂，子任务不带父任务的对话。父任务发的消息带 `sender`，时间线里折成「来自 <父任务>」。

**回报**，出处 Claude Code 嵌套会话、t3code `DelegatedCompletionDelivery`：
- 所有后代都做完、父会话空闲时，一次发给直接父任务，内容含标题、状态、最后回答前 400 字、分支。
- 回报逐层往上：孙任务的结果由子任务再做一轮后上报。下面还有任务在做、没起来或有结果待处理时，不叫醒上面；在等用户的不算。
- 不叫醒父会话、留到用户下次发消息时带上的情况：连续叫醒 3 次且用户没发过消息；用户自己开的回合；被打断或失败的回合；用户正在父会话打字或刚发消息。
- 子任务要批准或回答时也回报，父任务不能替用户回答，`aiwb_subtask_send` 报 `blocked`。

**安全规则**，出处 t3code `OrchestratorMcpService.ts`：
- 权限缺省继承，不能比父任务宽；父任务在计划模式时子任务也只能是计划模式。
- 调用方必须正处在回合里。
- 带 `clientRequestId` 的重试幂等。
- 父任务只能发普通消息，不能发斜杠命令。

## 已知限制
- 工具只能动直接子任务，不能读写孙任务。
- 层数没有硬上限，只靠权限继承和叫醒次数约束。
- 打断父任务不连带打断子任务。
- 待回报只在内存里，daemon 重启后没送出的不再送。
- 回合归谁按最后一次发消息的人算，用户在父任务开的回合里引导一句，这轮就算用户的。
- 按子任务自己设置排进队列的消息不带 `sender`。
- 适配器没有强制排队接口，`aiwb_subtask_send` 没有 `queue` 模式。
- 权限上限按父会话存下的档位算，Codex 用 `/permissions` 临时改的不算。
- Claude 的凭证在命令行参数里，同一用户的进程看得到。
- 独立聊天没有仓库，子任务不能开工作树。
- 不支持带上父任务对话开子任务、操控平级任务、替用户回答审批或提问、给外部客户端用 MCP。
