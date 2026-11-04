# 嵌套任务：Agent 把活拆给子任务

路线图第 19 项「Agent 互相驱动」。第一期做嵌套任务：会话里的 Agent 能开出挂在自己下面的子任务，子任务可以换 Agent、开自己的工作树，跑完把结果交回父任务，父任务接着往下做。同时补上 Agent 自带子 Agent 的展示，修掉一个相关的 bug（见「Agent 自带子 Agent」一节）。状态：嵌套任务、Agent 自带子 Agent 的展示和两个相关 bug 都已实现（2026-11-04）。

## 要解决的问题
- 一件事能拆成几块并行做，但都塞在一个会话里，就只能一块接一块地做，过程还把上下文撑满。
- 拆出去的活要能看见、能插手：在侧栏和看板上照常显示，用户随时点进去引导或打断。
- 子任务可以用别的 Agent，比如 Claude 拆出去让 Codex 写，再拿回来审。

不解决的：Agent 操控和自己无关的平级任务，比如去催别的任务、给别的任务发消息。这类跨任务协作等真有需求再放开，底层和本方案共用。

### 和 Agent 自带子 Agent 的分工
| | Agent 自带子 Agent | 嵌套任务 |
|---|---|---|
| 在哪跑 | 父 Agent 进程里 | 工作台里的独立任务 |
| 用户能否插手 | 只能看 | 能单独打开、引导、打断 |
| 检出 | 和父 Agent 共用 | 可以开自己的工作树 |
| Agent | 和父 Agent 相同 | 可以换 |
| 开销 | 小 | 每个子任务都是完整会话，启动时重新加载上下文 |

工具描述里要写明：轻量的活交给 Agent 自带的子 Agent；只有需要单独的工作树、需要用户插手，或者要换一个 Agent 来做时，才开嵌套任务。

## 参考

### Claude Code 桌面版：嵌套会话
2026-10-14 的桌面版更新加入。桌面版不开源，以下出处是产品行为和公开报道，不是源码。
- 会话可以开子会话，侧栏把子会话挂在父会话下面。可以一次开多个，开之前能改环境、模型、工作树和权限。
- 发起分三种：用户点名要做的任务，先弹卡片让用户选「另开」还是「就在这做」；用户明确说要开的，直接开；Agent 自己觉得该另开的，只能留一张卡片，等用户点。
- 上下文可选：`fork` 带上父会话的整段对话，`fresh` 只带一份简短说明。
- 父会话不用一直等着，可以先结束自己的回合。所有子会话都停下、父会话也空闲时，应用把父会话叫醒，附上各子会话最新报告的前 400 字左右。父会话里只留结果，不留过程。
- 回报只是对方的说法，告诉用户完成之前要自己看结果或 diff。
- 写代码的子会话各用自己的工作树和分支，合到一起前先问用户，不推送这些分支。
- 只能开 Claude，看不到 Codex 等别的 Agent。

### t3code：Orchestrator MCP
- **入口**：服务端在自己的 HTTP 端口挂 `/mcp`（`apps/server/src/mcp/McpHttpServer.ts`），工具定义在 `apps/server/src/mcp/toolkits/orchestrator/tools.ts`，实现在 `apps/server/src/mcp/OrchestratorMcpService.ts`。
- **认出是谁在调**：每次起 Agent 进程时，给这个会话发一个随机 token，内存里只存哈希，token 对应到调用方的线程（`McpSessionRegistry.ts` 的 `issue` / `resolve` / `revokeThread`）。会话结束就撤销，空闲 24 小时失效。
- **注入给 Agent**：
  - Codex 在 `thread/start` 的 `config` 里加 `mcp_servers.t3-code = {url, http_headers: {Authorization}, tool_timeout_sec: 3900}`，只覆盖自己这一项，用户配的 MCP 不受影响（`orchestration-v2/Adapters/CodexAdapterV2.ts` 的 `codexThreadRuntimeParams`）。
  - Claude 在 `mcpServers` 里加 `{type: "http", url, headers}`，同时把 `mcp__t3-code__*` 加进 `allowedTools`，不再弹审批（`ClaudeAdapterV2.ts`）。
- **子任务**：`delegate_task` / `task_status` / `task_cancel`，子任务跑完自动唤醒父会话（完成投递见 `DelegatedCompletionDelivery`）。
- **安全规则**：
  - 权限不能升级：目标会话的权限档位不能比调用方宽（`resolveRuntimeMode`，报 `runtime_mode_escalation_denied`）；计划模式同理（`resolveInteractionMode`）。
  - 调用方必须活着：调用方自己得有正在跑的回合（`assertLiveCaller`，报 `parent_not_active`），防止进程退出后旧 token 还能操作。
  - 重试幂等：`clientRequestId` 生成稳定的命令 id，重试不会重复建会话、重复发消息。
- **界面**：别的 Agent 发来的消息在时间线里折成一行，标出是哪个会话发的，可以展开（`apps/web/src/components/chat/TimelineUserMessageRow.tsx`，`createdBy: "agent"` + `senderThreadId`）。

### herdr：卡在审批时不塞输入
- herdr 给 Agent 一个 `herdr` 命令行加一份 skill（`skills/herdr/SKILL.md`），不做 MCP。
- `agent prompt` 遇到目标正卡在审批或提问上时直接拒绝（`agent_blocked`），不往里塞输入。本方案给子任务追加消息时照这条做。

## 本项目现有的底子
- daemon 已有的 RPC：`tasks.create`（项目、Agent、选项、工作树、首条消息）、`tasks.list`（每个任务带现在用的会话的 `attention`）、`sessions.send`（`now` 表示引导，否则排队）、`sessions.interrupt`（`crates/aiwb-daemon/src/services/mod.rs`），时间线也都在数据库里。
- 注意力状态 `aiwb-core::attention`：`needs-input`（附带 `ask` 区分批准和回答）/ `working` / `done` / `failed` / `idle`。状态变化时 hub 广播 `tasks` 主题，结果回报直接订阅它。
- 权限档位是工作台统一的：`read-only` / `ask` / `approve-for-me` / `full`（`aiwb-core::models::catalog`），可以直接排出宽窄。
- 注入点：
  - Codex 的 `thread/start` 已经在拼 `config`（`aiwb-agents/src/codex/sandbox.rs`）。
  - Claude 启动参数在 `aiwb-agents/src/claude/command.rs`，可以加 `--mcp-config` 和 `--allowedTools`。

## 方案

### 入口与凭证（照 t3code）
- daemon 的 axum 路由加 `/mcp`，走 MCP Streamable HTTP，只听回环地址，和 `/ws` 共用端口。协议层用官方 Rust SDK `rmcp`，不自己手写。
- 每次拉起 Agent 进程时，给这个会话发一个 token：内存里存哈希到会话 id 的映射，会话停止时撤销。daemon 重启后旧 token 全部失效，resume 时重新发。
- `SessionContext` 加 `workbench_mcp: Option<{url, token}>`，适配器负责注入：
  - Codex：`thread/start` 和 resume 时的 `config` 里加 `mcp_servers.aiwb`。
  - Claude：加 `--mcp-config` 传 `{"mcpServers":{"aiwb":{"type":"http","url":…,"headers":{…}}}}`，再用 `--allowedTools mcp__aiwb__*` 免审批。
- Codex 和 Claude 原生都支持 HTTP MCP，两个都实现，不加能力开关。
- 无状态：`rmcp` 关掉会话模式、回 JSON，每个请求单独处理，daemon 重启不用恢复 MCP 会话。
- 只发给项目里的顶层任务（`mcp::serves`）：子任务不能再开子任务，独立聊天没有项目，侧边聊天不发。
- 代码：`crates/aiwb-daemon/src/mcp/`（路由、凭证、调用方、各组工具），规则和数据在 `services/subtasks.rs`。新的一组工具加一个文件，在 `mcp/server.rs` 里加上它的路由。
- 工具调用都很快返回，不在工具调用里长时间等待，不需要拉长 `tool_timeout_sec`。

### 父子关系
- 任务加 `parentTaskId`，存进 SQLite。子任务和父任务同一个项目。
- 一个任务里可能换过 Agent，有多个会话；父子关系挂在任务上，回报投给父任务现在用的会话。
- 只允许一层：子任务不能再开子任务。等用顺了再看要不要放开。
- 侧栏把子任务挂在父任务下面，可以折叠。看板、注意力、通知照常工作。

### 工具（第一期）
所有工具都按调用方的会话来定作用范围，只能看到、动到自己的子任务。

| 工具 | 做什么 | 对应 RPC | 出处 |
|---|---|---|---|
| `aiwb_capabilities` | 列出能用的 Agent 和模型目录，以及调用方自己的 Agent、模型、权限档位 | `agents.catalog`、`sessions.catalog` | t3code `orchestrator_capabilities` |
| `aiwb_subtask_create` | 开一个或一批子任务：Agent、模型、选项、是否开工作树、首条消息。立刻返回，不等跑完 | `tasks.create` | Claude Code 嵌套会话、t3code `delegate_task` |
| `aiwb_subtask_list` | 列自己的子任务：标题、Agent、注意力状态、最后一条预览 | `tasks.list` | t3code `task_status` |
| `aiwb_subtask_read` | 分页读一个子任务的时间线，默认只有用户消息、回答和计划 | 事件表 | t3code `t3_thread_read` |
| `aiwb_subtask_send` | 给子任务追加消息，`mode` 取 `auto` / `steer` | `sessions.send` | t3code `t3_thread_send` |
| `aiwb_subtask_interrupt` | 打断子任务正在跑的回合 | `sessions.interrupt` | t3code `task_cancel` |

`aiwb_subtask_create` 的规则：
- 首条消息要写成能单独看懂的说明：要做什么、涉及哪些文件、做到什么算完。子任务不带父任务的对话。
- 工具描述里写明上文「分工」一节的取舍。

`aiwb_subtask_send` 的规则：
- `auto` 跟着子任务自己的「回合中再发消息」设置（排队或引导），`steer` 立刻引导。适配器没有强制排队的接口，不单列 `queue`。
- 子任务正在等审批或回答（`needs-input`）时拒绝，报 `blocked`，不替用户回答（herdr `agent_blocked`）。

### 用户同意（照 Claude Code 嵌套会话）
`aiwb_subtask_create` 带 `initiation` 参数，由 Agent 按下面的规则自己声明，工具描述里写清楚：

| `initiation` | 什么时候用 | 怎么开 |
|---|---|---|
| `user_asked` | 用户原话里要求另开、拆出去、后台跑，或者让它现在就开 | 直接开 |
| `offer` | 用户最新一条消息点了要做的事，但没说要另开 | 先在父任务时间线出卡片，用户选「另开」才开，选「就在这做」就告诉 Agent 在这里做；卡片先出，Agent 等用户选完再往下走 |
| `own_initiative` | 用户没让做、Agent 自己发现或提议的事 | 只出一张卡片，Agent 不等，接着做自己的；用户点了才开，一周没点就过期 |

- 用户让做的事一律不能声明成 `own_initiative`。
- 卡片列出要开的子任务：Agent、标题、首条消息摘要、是否开工作树。
- `own_initiative` 一个回合最多 3 张卡片，同一件事不重复提议。
- 卡片的结果按回报的路子送回父会话：用户点了「另开」，就回报子任务已开出；点了「就在这做」，就告诉 Agent 自己做。

### 结果回报（照 Claude Code 嵌套会话、t3code 完成投递）
- 父任务开完子任务可以接着干别的，也可以直接结束这一回合，不用一直挂着等。
- daemon 接会话状态变化（`Runtimes` 的状态通知，只在注意力状态真的变了时发）。子任务每结束一个回合（包括父任务追加消息后开的回合）都记一条待回报。等父任务的所有子任务都不在 `working`、父会话也空闲时，daemon 用 `sessions.send` 把待回报一次发给父会话，父会话就此开一个新回合。
- 回报一条消息里汇总所有待回报的子任务，每个子任务给：标题、状态（`done` / `failed` / `needs-input`）、最后一条回答的前 400 字左右、工作树分支。
- 父会话连续被回报叫醒多次、中间用户一条消息都没发时，后面的回报不再叫醒，留到用户下一次发消息时一起带上，防止父子来回空转。
- 以下回合的结果也不叫醒父会话，留到用户下一次发消息时带上：用户自己在子任务里发消息开的回合，以及被打断或失败的回合。
- 子任务停在 `needs-input` 时也回报，父任务据此告诉用户去处理，自己不替用户回答。
- 回报只是子任务的说法：回报正文要求父任务告诉用户「完成了」之前，先读子任务的结果或看 diff；合并几个子任务的改动要先问用户、不推送分支。这两条只写在回报里，工具描述不重复，免得每个请求都带着。
- 写给模型的文字（工具描述、返回值、报错、回报）统一用英文，错误码前缀不变；用户点卡片时看到的报错仍是中文。
- 用户在父会话里正在打字（30 秒内改过有字的草稿）或者刚发了消息时，回报排队，不打断用户：留到用户发消息时一起带上，或者下一次状态变化再看。
- 待回报只在内存里：daemon 重启后会话都记成已停止，没送出的回报不再送。
- 时间线里回报折成一行，标出「来自 <子任务标题>」，点开看全文，点标题跳过去（照 t3code `TimelineUserMessageRow.tsx`）。为此用户消息事件加 `sender: {task_ids}` 字段（一次回报可能汇总几个子任务）。用户发消息时带上的回报单独记一行，用户气泡只画用户写的。

### 工作树与合并
- 开了工作树的子任务，改动在自己的分支上。回报里带上分支名。
- 工具描述里写明：要把几个子任务的改动合到一起，先问用户，用户同意才合；不推送这些分支。

### 安全规则（照 t3code）
- **权限不升级**：子任务的权限档位缺省继承父任务；指定的档位比父任务宽就拒绝（`read-only` < `ask` < `approve-for-me` < `full`）。父任务在计划模式时，子任务也只能是计划模式。
- **调用方必须活着**：调用工具时，确认调用方的会话正处在一个回合里。
- **重试幂等**：可以带 `clientRequestId`，daemon 在内存里记一段时间，重试时直接返回上次的结果。
- **只能动自己的子任务**：list、read、send、interrupt 都只认 `parentTaskId` 是调用方任务的子任务。

### 已知的取舍
- 谁让子任务这一回合跑的按最后一次发消息的人算：用户在父任务开的回合里引导一句，这一回合就算用户的，不叫醒父会话；反过来也一样。
- Claude 的凭证在 `--mcp-config` 的命令行参数里，同一用户的进程看得到。凭证只能动调用方自己的子任务，且只在它的回合里有效；「子任务不能再开子任务」是工作台的规则，不是安全边界。
- 权限上限按父会话存下的档位算。Codex 里用 `/permissions` 临时改的档位不写回会话选项，作曲栏里改的才算。
- 父任务给子任务发的只能是普通消息，斜杠命令（能改权限和模式）一律拒绝。
- 适配器用 `takes_workbench_mcp` 声明会注入工作台 MCP。现在是 Codex 和 Claude；Cursor 原生也有 MCP，还没用真实 CLI 验证能否按会话注入，先不发凭证。
- 父任务发给子任务的消息（第一条说明、追加的消息）带 `sender`，子任务时间线里折成「来自 <父任务>」。按子任务自己的设置排进队列的那条，等真正发出时由适配器记，不带 `sender`。

### 不在第一期
- 带上父任务对话开子任务（Claude Code 的 `fork`）。
- 子任务再开子任务。
- 操控平级任务：开普通顶层任务、给无关任务发消息或打断。
- 替用户回答审批或提问。
- 定时任务（路线图第 20 项）。
- 给外部客户端用的 MCP（t3code 的 `McpClientCaller`）。只给工作台自己拉起的会话用。

## Agent 自带子 Agent
Codex、Claude 都能自己派出子 Agent。v1 没做这块；v2 的适配器从 v1 搬过来，也没处理。下面是当时的 bug、丢掉的原生事件和照 t3code 补的展示，都已实现。

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

  实测 codex-cli 0.165.0（2026-11-04，`multi_agent` 和 `multi_agent_v2` 各跑一遍，报法一样）：派出只报 `subAgentActivity`（`kind = started`，`id` 是那次调用），没有 `spawnAgent` 的 `collabAgentToolCall`；结束是另一条 `subAgentActivity`（`kind = completed`，`id = subagent-completed-<子线程回合 id>`）；`collabAgentToolCall` 只出现了 `wait`，`receiverThreadIds` 和 `agentsStates` 都是空的。子线程不带派给它的说明。
- **Bug：Codex 子线程混进主会话**。子线程的 `item/*`、`turn/*`、`thread/status/changed` 也走同一条连接，`threadId` 是子线程。适配器除了用量和线程状态以外都不看 `threadId`，于是子 Agent 的命令和回答画进了主时间线，子线程的 `turn/completed` 还会把主回合的 `turn_id` 清掉、把回合标成已结束。修法：本会话有线程 id 之后，别的线程的通知一律不按主线程处理，已知的子线程归到它的卡片下面（`crates/aiwb-agents/src/codex/subagents.rs` 的 `route_foreign_thread`）。

### 展示方案（照 t3code）
- **时间线**：派子 Agent 的那次工具调用画成一行子 Agent 卡片，显示描述、Agent 类型、模型、状态（运行中 / 完成 / 失败 / 已停止）和用时。同一轮里派出多个时归成一组，组头汇总各个状态。出处：t3code `apps/web/src/components/chat/TimelineV2EventRow.tsx` 的 `V2SubagentGroup`、`packages/client-runtime/src/state/subagent-display.ts` 的 `subagentGroupSummary` / `summarizeSubagentStatuses`。
- **展开看过程**：点开卡片，看子 Agent 自己的消息和工具调用，也就是现在被挡在主时间线外的那些（Claude 按 `parent_tool_use_id` 归，Codex 按子线程 id 归）。t3code 把子 Agent 做成能单独打开的子会话，顶上有一条显示 Agent、模型、状态的栏，可以跳回父会话（`apps/web/src/components/chat/ProviderSubagentBar.tsx`）。我们先做卡片内展开，不另开会话。
- **结果**：完成时卡片里显示 `summary`（Claude）或子线程的最后一条回答（Codex），以及用量。
- **注意力**：子 Agent 在跑时，主会话算运行中。Claude 后台子 Agent 还没完时，主回合已经结束了，这时看板和侧栏仍然显示运行中，不算完成。
- **归一化**：`aiwb-core` 加子 Agent 事件（开始、更新、结束，带父工具调用 id、描述、模型、状态、结果、用量），子 Agent 的消息带上所属子 Agent 的 id。两个适配器各自转换，界面不按 Agent 名字区分。

### 实现
- **事件**：`subagent` 是一张卡片（`SubagentCard`），同一个 `subagent_id` 整条替换，适配器每次发全量；`subagent-step` 包着子 Agent 自己的一条回答、思考或工具调用，只和同一个子 Agent 的步骤按原规则覆盖（`crates/aiwb-core/src/timeline.rs`）。步骤是单独的事件，主时间线、交接、注意力预览都不会把它当成主 Agent 的话。卡片 id：Claude 用派它的工具调用 id，Codex 用子线程 id。交接时卡片按「Subagent: 描述 + 结果」带上，步骤不带。
- **Claude**（`crates/aiwb-agents/src/claude/subagents.rs`）：`Agent` / `Task` 工具调用画成卡片，不再是工具行。`task_started`（只认 `task_type = local_agent`）、`task_progress`、`task_updated`、`task_notification` 改卡片；前台的结果、模型、用量取工具结果的 `tool_use_result`，后台的工具结果只是 `async_launched`。带 `parent_tool_use_id` 的消息用子 Agent 自己的映射状态转成步骤；不用工具的子 Agent，CLI 不一定把它的回答推到 stdout，这时只有卡片上的结果。读转录时卡片来自主链，步骤读 `<会话 id>/subagents/agent-<agentId>.jsonl`，后台子 Agent 结束时那条 `origin.kind = task-notification` 的用户消息改卡片，不画气泡。
- **Codex**（`crates/aiwb-agents/src/codex/subagents.rs`）：主线程的 `subAgentActivity` 和 `collabAgentToolCall` 改卡片，标题取 `agentPath` 最后一段；子线程的完成条目转成步骤（不做流式），最后一条回答当结果，`turn/completed` 失败或中断时改状态，`thread/tokenUsage/updated` 记用量。读历史时卡片留在原位置，再用 `thread/read` 读每个子线程补步骤、结果和 `agentRole` / `agentNickname`。
- **停掉**：进程退出或被停时还在跑的卡片记成已停止；daemon 启动时，上次没跑完的会话和主回合已完成但还有后台子 Agent 的会话也这样记（`settle_interrupted`）。
- **注意力**：会话状态是已完成但还有卡片在跑时算「在做」，卡片变了按最后的状态重算（`crates/aiwb-core/src/attention.rs` 的 `on_subagent`）。空闲回收不收这样的会话。
- **界面**（`src/features/chat/events/SubagentGroup.tsx`、`subagent-display.ts`）：相邻的卡片收成一组，组头是「N 个子 Agent · 各状态个数」。卡片不算过程，回合收起时也留在外面。点开看说明、步骤（和过程一样相邻工具收成一行）、结果和用量；结果和最后一句回答相同时不重复。开发预览 `?preview=subagents`。

## 验证
已有：`cargo test -p aiwb-daemon --test subtasks`（假适配器走真实 HTTP）；`--test subtasks_cli -- --ignored`（真实 CLI，Claude 开 Codex、Codex 开 Claude，2026-11-04 通过）。下面的清单里没写进测试的，靠这两份覆盖或留到后面。

- 单元测试：token 的发放、解析和撤销；权限宽窄比较；只能动自己的子任务；回报的触发条件（所有子任务停下、父会话空闲、用户在打字时排队、连续叫醒后留到用户下一条消息）。
- 真实 CLI（Codex、Claude 各一遍，`--ignored` 集成测试）：
  - Claude 父任务开一个 Codex 子任务，反过来再来一遍。子任务跑完，父会话收到回报并开新回合，读出子任务的回答。
  - 一次开两个子任务，两个都停下后只回报一次，里面有两个结果。
  - 子任务卡在审批时，父任务收到 `needs-input` 回报；父任务追加消息被拒绝。
  - 子任务要求比父任务宽的权限被拒绝。
  - 父任务打断子任务。
  - `offer` 出卡片，选「另开」开出子任务，选「就在这做」父任务自己做；`own_initiative` 出卡片且父任务不等；`user_asked` 直接开。
  - 父任务给子任务追加消息，子任务这一回合结束后父会话再被叫醒；用户自己在子任务里发的消息不叫醒父会话。
- 桌面上走一遍：侧栏里子任务挂在父任务下面，父任务时间线里能看到折叠的「来自 <子任务>」，看板和通知都正常。
- 子 Agent：
  - 单元测试（报文从实录截取）：Claude 实时流里带 `parent_tool_use_id` 的消息挂到卡片下、不进主时间线；前台、后台两种 `Agent` 调用和 `task_*` 事件转成卡片；读转录恢复卡片和子 Agent 自己的步骤；Codex 子线程的条目和回合不进主会话、不收主回合，历史里卡片留在原位置；步骤只在同一个子 Agent 里合并；后台子 Agent 在跑时会话算在做。
  - 真实 CLI：`cargo test -p aiwb-daemon --test subagents_cli -- --ignored --nocapture --test-threads=1`。Claude、Codex 各并行派两个，卡片都完成、结果是 PING 和 PONG、跑命令的那个有命令步骤、主时间线里没有子 Agent 的话；Claude 派一个后台的，主回合完了任务仍是在做，跑完变成完成，换一个 daemon 打开同一个库卡片不变。2026-11-04 通过（Claude Code 2.1.312，codex-cli 0.165.0）。

## 已确认
1. 第一期只允许一层嵌套。
2. 开子任务要不要用户同意，照 Claude Code 分 `user_asked` / `offer` / `own_initiative` 三种，由 Agent 声明。
3. 回报照 Claude Code：等所有子任务都停下、父会话空闲时一起发。
