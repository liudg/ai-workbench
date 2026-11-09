# Agent 开会话

Agent 把工作交出去有三个去处，按结果归谁、谁来管分：

| 去处 | 结果给谁 | 用户管不管 | 实现 |
|---|---|---|---|
| 自带的子 Agent | 调用方 | 不管 | Agent 的原生工具，工作台只展示 |
| 子任务（嵌套会话） | 调用方 | 可打开、引导、停止 | `aiwb_subtask_create` |
| 独立会话 | 不回来 | 和手动新建的一样 | `aiwb_session_create` |

## 已实现

**接入**
- daemon 在 `/mcp` 提供 MCP Streamable HTTP，只听回环地址，和 `/ws` 共用端口，用 `rmcp`，无状态。代码在 `crates/aiwb-daemon/src/mcp/`。开会话（设置补全、权限上限、卡片）的规则在 `services/agent_sessions.rs`，子任务开出来之后的回报和操控在 `services/subtasks.rs`。出处：t3code `apps/server/src/mcp/McpHttpServer.ts`。
- 每次拉起 Agent 进程发一个 token，内存里存哈希，会话停止时撤销，daemon 重启后 resume 时重发（`mcp/tokens.rs`）。出处：t3code `McpSessionRegistry.ts`。
- 所有任务都有工作台 MCP：项目里的、独立聊天和嵌套会话一样；侧边聊天没有。
- 注入方式，出处 t3code `CodexAdapterV2.ts`、`ClaudeAdapterV2.ts`：
  - Codex：`thread/start` 和 resume 的 `config` 加 `mcp_servers.aiwb`，不影响用户配的 MCP。
  - Claude：`--mcp-config` 加 `--allowedTools mcp__aiwb__*` 免审批。
  - Cursor：`session/new`、`session/load` 的 `mcpServers` 传 ACP `McpServerHttp`；`aiwb: aiwb_*` 的审批替用户选「允许一次」。
- 使用说明（`WorkbenchMcp::INSTRUCTIONS`）跟着 MCP 一起给：Codex 放进 `turn/start.additionalContext`，Claude 用 `--append-system-prompt`，Cursor 放在进程第一条提示前。内容只定义三个去处的区别，让 Agent 按结果归谁、工作放在哪判断，不列用户的说法。出处：t3code `orchestrationInstructions.ts`、`CodexDeveloperInstructions.ts`。

**工具**：`aiwb_session_create` 开出来就和调用方没有关系；其余只能动调用方自己的直接子任务。

| 工具 | 做什么 | 出处 |
|---|---|---|
| `aiwb_capabilities` | 能用的 Agent、模型目录和调用方自己的设置 | t3code `orchestrator_capabilities` |
| `aiwb_subtask_create` | 开一个或一批，立刻返回 | Claude Code 嵌套会话、t3code `delegate_task` |
| `aiwb_session_create` | 开一个或一批独立的顶层会话，可以不给首条消息 | Claude Code 桌面版 `start_session` |
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

**独立会话**
- 不带 `parentTaskId`，和调用方同一个项目；独立聊天开的另建文件夹。结果不回报，`aiwb_subtask_*` 也动不了。
- 权限缺省继承且不能更宽，调用方在计划模式时也是计划模式，和子任务一样，否则 Agent 能借它绕开自己的权限。
- 首条消息带 `sender`，时间线里看得出是谁开的；调用方的时间线里留一条能点开的记录。
- 开会话时 `context` 选 `fresh` 或 `fork`，照 Claude Code 桌面版 `start_session`（2026-11-09 对照 3.6556 的 app.asar 和真实转录）。
  - `fresh`（缺省）：新会话只收到 `prompt` 和 `background`。有 `prompt` 时 `background` 必填，至少 80 字。
  - `fork`：新会话带着发起会话的完整对话，再收到 `prompt`。只能同一个 Agent，`supports_fork` 的才行，不能另选工作树、模型和强度。从工作树里分叉到新工作树，从当前提交切出，没提交的改动留在原地；否则共用目录。时间线抄一份，停在分叉处。
  - 时间线只存 `prompt`，`background`、笔记目录和是否分叉放在 `sender` 上，头部卡片分开折叠显示。卡片的信息和折叠方式照 Claude Code 桌面版嵌套会话的头部。
- 一组嵌套会话共用一个笔记目录（`<数据目录>/session-notes/<最上面的任务 id>`），路径跟第一条消息一起给，子任务可写。最上面的任务删掉时一起删。
- 子任务多收到一段说明（`WorkbenchMcp::instructions`）：只做交给它的事，最后一条消息的前 400 字会回报给父会话。
- 不给首条消息时只建任务，状态 `idle`，不拉起 Agent，等用户自己发。
- 卡片和直接开出的记录是同一种事件，`link` 区分子任务和独立会话；早先落库的没有这个字段，算子任务。

**父子关系**
- 任务带 `parentTaskId`，和父任务同一个项目，层数不限。
- 独立聊天开的子任务用聊天自己的文件夹，删子任务不动这个文件夹。
- 父子关系挂在任务上，换过 Agent 时回报投给父任务现在用的会话。
- 首条消息要能单独看懂，子任务不带父任务的对话。父任务发的消息带 `sender`，时间线里折成「来自 <父任务>」。

**创建和启动**
- 手动新建与嵌套会话共用创建事务：任务、会话、已接收的首条消息一起写入 SQLite，再异步启动 Agent。启动前状态为 `starting`，空任务为 `idle`，不能使用 `completed`。
- 卡片、侧栏和聊天页使用 daemon 的状态和事件；刷新后仍可读到任务说明。原生进程接通时的空闲通知不算首轮完成。
- 首条说明直接投递；若目标已自动开启回合，说明交给该回合。已落库的消息不再追加第二份。
- 取消启动后不再投递，晚到的启动结果会关闭；启动失败保留说明并记录错误。daemon 重启把未结束的 `starting` 收敛为 `stopped`，不自动重发。
- 实现在 `services/tasks.rs`、`runtime/startup.rs`、`runtime.rs` 和 `aiwb-store/src/tasks.rs`；慢启动、取消、失败及持久化回归在 `tests/subtasks.rs`。

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
- 不支持带上父任务对话开子任务或独立会话、操控平级任务、替用户回答审批或提问、给外部客户端用 MCP。
