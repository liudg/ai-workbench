# Agent 驱动工作台：本地 MCP 方案

路线图第 19 项「Agent 互相驱动」。让会话里的 Agent 能在工作台里开新会话、给别的会话发消息、等它跑完、打断它。同时补上 Agent 自带子 Agent 的展示，修掉一个相关的 bug（见「Agent 自带子 Agent」一节），两件事一起做。状态：方案待确认，未动代码。

## 参考项目怎么做的

### t3code：Orchestrator MCP
- **入口**：服务端在自己的 HTTP 端口挂 `/mcp`（`apps/server/src/mcp/McpHttpServer.ts`），工具定义在 `apps/server/src/mcp/toolkits/orchestrator/tools.ts`，实现在 `apps/server/src/mcp/OrchestratorMcpService.ts`。
- **认出是谁在调**：每次起 Agent 进程时，给这个会话发一个随机 token，内存里只存哈希，token 对应到调用方的线程（`McpSessionRegistry.ts` 的 `issue` / `resolve` / `revokeThread`）。会话结束就撤销，空闲 24 小时失效。
- **注入给 Agent**：
  - Codex 在 `thread/start` 的 `config` 里加 `mcp_servers.t3-code = {url, http_headers: {Authorization}, tool_timeout_sec: 3900}`，只覆盖自己这一项，用户配的 MCP 不受影响（`orchestration-v2/Adapters/CodexAdapterV2.ts` 的 `codexThreadRuntimeParams`）。
  - Claude 在 `mcpServers` 里加 `{type: "http", url, headers}`，同时把 `mcp__t3-code__*` 加进 `allowedTools`，不再弹审批（`ClaudeAdapterV2.ts`）。
  - 超时设成 65 分钟，比最长等待（60 分钟）长，让服务端自己的超时先到。
- **工具**（和本方案相关的部分）：
  - `orchestrator_capabilities`：列出能用的 Agent、模型，以及调用方自己的设置。
  - `create_threads`：开一批普通的顶层会话，和调用方同一个项目、同一个检出。描述里要求「用户明确要另开会话时才用」。
  - `t3_thread_list` / `t3_thread_read`：列会话、分页读时间线（默认只读用户消息、回答、计划）。
  - `t3_thread_send`：给会话发消息。`mode` 取 `auto` / `queue` / `steer` / `restart`；`auto` 在空闲时开新回合，回合进行中能引导就引导，否则排队。
  - `t3_thread_wait`：等最新一轮跑到终态。默认 10 分钟，最长 60 分钟；超时不打断对方。
  - `t3_thread_interrupt`：打断正在跑的回合。
  - 还有一些不在本方案第一期：`delegate_task` / `task_status` / `task_cancel`（子任务，跑完自动唤醒父会话）、`schedule_task` 等定时任务、`request_secret`。
- **安全规则**：
  - 权限不能升级：目标会话的权限档位不能比调用方宽（`resolveRuntimeMode`，报 `runtime_mode_escalation_denied`）；计划模式同理（`resolveInteractionMode`）。
  - 调用方必须活着：动别的会话时，调用方自己得有正在跑的回合（`assertLiveCaller`，报 `parent_not_active`），防止进程退出后旧 token 还能操作。
  - 重试幂等：`clientRequestId` 生成稳定的命令 id，重试不会重复建会话、重复发消息。
- **界面**：别的 Agent 发来的消息在时间线里折成一行，标出是哪个会话发的，可以展开（`apps/web/src/components/chat/TimelineUserMessageRow.tsx`，`createdBy: "agent"` + `senderThreadId`）。

### herdr：`herdr agent` 命令行 + skill
- herdr 不做 MCP：它给 Agent 一个 `herdr` 命令行，再配一份 skill 说明怎么用（`skills/herdr/SKILL.md`）。命令走本地 socket 发到 herdr 服务。
- **状态**：`idle` / `working` / `blocked`（等审批或回答）/ `done` / `unknown`（`src/api/schema/common.rs` 的 `AgentStatus`）。
- **`agent wait`**：默认等到 `idle`、`done`、`blocked` 中的任意一个，也可以用 `--until` 指定（`src/api/wait.rs` 的 `agent_wait_statuses`）。它订阅事件，不靠轮询。
- **`agent prompt --wait`**：
  - 目标正卡在审批或提问上时，直接拒绝（`agent_blocked`），不往里塞输入。skill 要求先看一眼再问用户。
  - 发出后 5 秒内没看到 `working` 或 `blocked`，就返回 `agent_prompt_stalled`，避免把旧的 `done` 当成这次的结果。
  - 超时或卡住都不代表没发出去，skill 要求先读状态，不要盲目重发。

## 本项目现有的底子
- daemon 已有的 RPC：`tasks.create`（项目、Agent、选项、工作树、首条消息）、`tasks.list`（每个任务带现在用的会话的 `attention`）、`sessions.send`（`now` 表示引导，否则排队）、`sessions.interrupt`，时间线也都在数据库里。
- 注意力状态 `aiwb-core::attention`：`needs-input`（附带 `ask` 区分批准和回答）/ `working` / `done` / `failed` / `idle`，和 herdr 的状态一一对应。状态变化时 hub 会广播 `tasks` 主题，等待可以直接订阅它。
- 权限档位是工作台统一的：`read-only` / `ask` / `approve-for-me` / `full`（`aiwb-core::models::catalog`），可以直接排出宽窄。
- 注入点：
  - Codex 的 `thread/start` 已经在拼 `config`（`aiwb-agents/src/codex/sandbox.rs`）。
  - Claude 启动参数在 `aiwb-agents/src/claude/command.rs`，可以加 `--mcp-config` 和 `--allowedTools`。

## 方案

### 入口与凭证（照 t3code）
- daemon 的 axum 路由加 `/mcp`，走 MCP Streamable HTTP，只听回环地址，和 `/ws` 共用端口。协议层用官方 Rust SDK `rmcp`，不自己手写。
- 运行时每次拉起 Agent 进程时，给这个会话发一个 token：内存里存哈希到会话 id 的映射，会话停止时撤销。daemon 重启后旧 token 全部失效，resume 时重新发。
- `SessionContext` 加 `workbench_mcp: Option<{url, token}>`，适配器负责注入：
  - Codex：`thread/start` 和 resume 时的 `config` 里加 `mcp_servers.aiwb`，`tool_timeout_sec` 设 3900。
  - Claude：加 `--mcp-config` 传 `{"mcpServers":{"aiwb":{"type":"http","url":…,"headers":{…}}}}`，再用 `--allowedTools mcp__aiwb__*` 免审批。
- Codex 和 Claude 原生都支持 HTTP MCP，两个都实现，不加能力开关。

### 工具（第一期）
所有工具都按调用方的会话来定作用范围；省略项目时，默认用调用方所在的项目。

| 工具 | 做什么 | 对应 RPC | 出处 |
|---|---|---|---|
| `aiwb_capabilities` | 列出能用的 Agent 和模型目录，以及调用方自己的 Agent、模型、权限档位 | `agents.catalog`、`sessions.catalog` | t3code `orchestrator_capabilities` |
| `aiwb_task_list` | 列项目里的任务：标题、Agent、注意力状态、最后一条预览 | `tasks.list` | t3code `t3_thread_list` |
| `aiwb_task_read` | 分页读一个任务的时间线，默认只有用户消息、回答和计划 | 事件表 | t3code `t3_thread_read` |
| `aiwb_task_create` | 开新任务：Agent、模型、选项、是否开工作树、首条消息。描述里写明「用户要求另开会话时才用」 | `tasks.create` | t3code `create_threads` |
| `aiwb_session_send` | 给任务发消息，`mode` 取 `auto` / `queue` / `steer` | `sessions.send` | t3code `t3_thread_send` |
| `aiwb_session_wait` | 等到指定状态，返回状态和最后一条回答的预览 | 订阅 `tasks` | herdr `agent wait`、t3code `t3_thread_wait` |
| `aiwb_session_interrupt` | 打断正在跑的回合 | `sessions.interrupt` | t3code `t3_thread_interrupt` |

`aiwb_session_send` 的规则：
- 目标正在等审批或回答（`needs-input`）时拒绝，报 `blocked`，不替用户答（herdr `agent_blocked`；t3code 也不授予审批权）。
- 返回这条消息的 `seq`。`aiwb_session_wait` 带上 `afterSeq` 后，只认这条消息之后的状态，不会把上一轮的 `done` 当成这次的结果（对应 herdr 的 stall 检查）。

`aiwb_session_wait` 的规则：
- 默认等到 `done` / `failed` / `needs-input` / `idle` 中的任意一个（照 herdr 的默认值，`failed` 在我们这里是单独的状态）。
- 超时默认 10 分钟，最长 60 分钟；超时只返回 `timedOut`，不打断对方（照 t3code）。

### 安全规则（照 t3code）
- **权限不升级**：新任务的权限档位缺省继承调用方；指定的档位比调用方宽就拒绝（`read-only` < `ask` < `approve-for-me` < `full`）。调用方在计划模式时，新任务也只能是计划模式。给别的任务发消息时，目标的档位比调用方宽也拒绝。
- **调用方必须活着**：动别的任务前，确认调用方的会话正处在一个回合里。
- **重试幂等**：可以带 `clientRequestId`，daemon 在内存里记一段时间，重试时直接返回上次的结果。

### 界面
- 时间线里，别的 Agent 发来的用户消息折成一行，标出「来自 <任务标题>」，点开看全文，点标题跳过去（照 t3code `TimelineUserMessageRow.tsx`）。为此用户消息事件要加 `sender: {taskId}` 字段。
- Agent 开出来的任务在侧栏和普通任务一样显示，注意力、看板、通知都照常工作，不另做界面。

### 不在第一期
- 子任务：`delegate_task`，子任务跑完自动唤醒父会话。要做父子关系和完成投递（t3code `DelegatedCompletionDelivery`），等第一期用顺了再说。
- 替用户回答审批或提问。
- 定时任务（路线图第 20 项）。
- 给外部客户端用的 MCP（t3code 的 `McpClientCaller`）。第一期只给工作台自己拉起的会话用。

## Agent 自带子 Agent
Codex、Claude 都能自己派出子 Agent。v1 没做这块；v2 的适配器从 v1 搬过来，也没处理。下面是已知的 bug 和照 t3code 补展示的方案。

### Bug：Claude 子 Agent 的回答混进主时间线
- 现象：Claude 派出子 Agent 后，子 Agent 说的话在时间线里显示成主 Agent 的回答。
- 原因：实时 stream-json 里，子 Agent 的消息只带 `parent_tool_use_id`（是派它的那次 `Agent` 工具调用的 id），不带 `isSidechain`。适配器只按 `isSidechain` 把旁路挡在时间线外（`crates/aiwb-agents/src/claude/messages.rs` 的 `on_assistant`），于是这些消息被当成了主 Agent 的。从转录文件导入或恢复时，记录里有 `isSidechain`，会正确跳过，所以只有实时流有问题，而且关掉再打开后时间线和刚才看到的不一样。
- 修法：`parent_tool_use_id` 不为空的 `assistant` 和 `user` 消息不进主时间线，用量照旧记上（和 `isSidechain` 同一条路）。做了下面的展示后，这些消息改为归到对应的子 Agent 下面。t3code 也按 `parent_tool_use_id` 区分主线和子 Agent（`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`）。
- 复现（2026-10-29，Claude Code 2.1.312，haiku）：`claude -p --output-format stream-json --verbose`，让它用 `Agent` 工具派一个回复 PONG 的子 Agent。输出里有一条 `"parent_tool_use_id":"toolu_…"` 的 assistant 消息，内容是 PONG，没有 `isSidechain`。

### 现在丢掉的原生事件
- **Claude**：`Agent` 工具默认在后台跑，工具结果当场返回「已启动」。之后 CLI 发出 `system` 事件，我们的 `on_system` 都没处理：
  - `task_started`：带 `task_id`、`tool_use_id`、`description`、`subagent_type`、`prompt`、`is_backgrounded`。
  - `task_updated`：状态变化，`patch.status`。
  - `task_notification`：结束时发出，带 `status`、`summary`（结果）、`usage`（token、工具次数、用时）、`output_file`。
  - `background_tasks_changed`：现在在跑的后台任务列表。
  - `task_summary`：进行中的一句话摘要。

  子 Agent 跑完会把主 Agent 叫醒，CLI 自己开一个新回合。这一点之前已经按「Agent 自己开的回合」单独成一轮显示了。
- **Codex**：app-server 的 `item/started` 和 `item/completed` 里有两种 item，适配器没认，直接丢掉了：
  - `collabAgentToolCall`：`tool` 取 `spawnAgent` / `sendInput` / `wait` / `closeAgent` 等，带 `senderThreadId`、`receiverThreadIds`、`agentsStates`、`status`。
  - `subAgentActivity`：带 `agentThreadId`、`agentPath`、`kind`、`model`、`reasoningEffort`。

  子 Agent 是 Codex 里的独立原生线程（`receiverThreadIds`）。

### 展示方案（照 t3code）
- **时间线**：派子 Agent 的那次工具调用画成一行子 Agent 卡片，显示描述、Agent 类型、模型、状态（运行中 / 完成 / 失败 / 已停止）和用时。同一轮里派出多个时归成一组，组头汇总各个状态。出处：t3code `apps/web/src/components/chat/TimelineV2EventRow.tsx` 的 `V2SubagentGroup`、`packages/client-runtime/src/state/subagent-display.ts` 的 `subagentGroupSummary` / `summarizeSubagentStatuses`。
- **展开看过程**：点开卡片，看子 Agent 自己的消息和工具调用，也就是现在被挡在主时间线外的那些（Claude 按 `parent_tool_use_id` 归，Codex 按子线程 id 归）。t3code 把子 Agent 做成能单独打开的子会话，顶上有一条显示 Agent、模型、状态的栏，可以跳回父会话（`apps/web/src/components/chat/ProviderSubagentBar.tsx`）。我们先做卡片内展开，不另开会话。
- **结果**：完成时卡片里显示 `summary`（Claude）或子线程的最后一条回答（Codex），以及用量。
- **注意力**：子 Agent 在跑时，主会话算运行中。Claude 后台子 Agent 还没完时，主回合已经结束了，这时看板和侧栏仍然显示运行中，不算完成。
- **归一化**：`aiwb-core` 加子 Agent 事件（开始、更新、结束，带父工具调用 id、描述、模型、状态、结果、用量），子 Agent 的消息带上所属子 Agent 的 id。两个适配器各自转换，界面不按 Agent 名字区分。

## 验证
- 单元测试：token 的发放、解析和撤销；权限宽窄比较；`afterSeq` 等待的边界情况。
- 真实 CLI（Codex、Claude 各一遍，`--ignored` 集成测试）：
  - A 会话开一个 B 任务并发出首条消息，等到 `done`，读出 B 的回答。
  - B 卡在审批时，A 发消息被拒绝。
  - A 要求比自己宽的权限被拒绝。
  - A 打断 B。
- 桌面上走一遍：侧栏出现 B，B 的时间线里能看到折叠的「来自 A」，看板和通知都正常。
- 子 Agent：
  - 单元测试：Claude 实时流里带 `parent_tool_use_id` 的消息不进主时间线；`task_*` 事件转成子 Agent 事件；Codex 的两种 item 转成同一组事件。
  - 真实 CLI（Codex、Claude 各一遍）：派一个子 Agent，再并行派两个。卡片的状态、结果、用量要对；关掉窗口再打开、daemon 重启后 resume，时间线和刚才一致。

## 待确认
1. 第一期的工具范围是否就这 7 个。
2. Agent 开任务要不要先经你同意：现在的方案是只靠工具描述约束，加上权限不升级；也可以改成每次开任务都弹一张审批卡。
