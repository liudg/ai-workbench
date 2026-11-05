# 嵌套任务与 Agent 自带子 Agent

路线图第 19 项「Agent 互相驱动」的第一期，2026-11-04 实现。
- **嵌套任务**：会话里的 Agent 经工作台 MCP 开出挂在自己下面的子任务，子任务可以换 Agent、开自己的工作树，跑完把结果交回父任务。
- **Agent 自带子 Agent**：Codex、Claude 原生派出的子 Agent 在时间线里画成卡片，点开看子 Agent 自己的过程。

两者的分工（工具描述里也写明：轻量的活交给 Agent 自带的子 Agent，需要单独的工作树、需要用户插手或要换 Agent 时才开嵌套任务）：

| | Agent 自带子 Agent | 嵌套任务 |
|---|---|---|
| 在哪跑 | 父 Agent 进程里 | 工作台里的独立任务 |
| 用户能否插手 | 只能看 | 能单独打开、引导、打断 |
| 检出 | 和父 Agent 共用 | 可以开自己的工作树 |
| Agent | 和父 Agent 相同 | 可以换 |
| 开销 | 小 | 每个子任务都是完整会话 |

## 嵌套任务

### 接入
- daemon 的 axum 路由挂 `/mcp`（MCP Streamable HTTP），只听回环地址，和 `/ws` 共用端口。协议层用官方 Rust SDK `rmcp`。出处：t3code `apps/server/src/mcp/McpHttpServer.ts`。
- 凭证：每次拉起 Agent 进程时给这个会话发一个 token，内存里存哈希到会话 id 的映射，会话停止时撤销；daemon 重启后旧 token 全部失效，resume 时重新发（`crates/aiwb-daemon/src/mcp/tokens.rs`）。出处：t3code `McpSessionRegistry.ts`。
- 注入：`SessionContext.workbench_mcp` 带 `{url, token}`，适配器用 `takes_workbench_mcp` 声明会注入。出处：t3code `CodexAdapterV2.ts`、`ClaudeAdapterV2.ts`。
  - Codex：`thread/start` 和 resume 的 `config` 里加 `mcp_servers.aiwb`，只覆盖这一项，用户配的 MCP 不受影响。
  - Claude：`--mcp-config` 传 `{"mcpServers":{"aiwb":{"type":"http",…}}}`，`--allowedTools mcp__aiwb__*` 免审批。
- 只发给项目里的顶层任务（`mcp::serves`）：子任务不能再开子任务，独立聊天和侧边聊天不发。
- 代码：`crates/aiwb-daemon/src/mcp/`（路由、凭证、调用方、工具），规则和数据在 `services/subtasks.rs`。新的一组工具加一个文件，在 `mcp/server.rs` 里加路由。

### 父子关系
- 任务带 `parentTaskId`，存进 SQLite，子任务和父任务同一个项目。只允许一层。
- 父子关系挂在任务上，任务换过 Agent 时回报投给父任务现在用的会话。
- 侧栏把子任务挂在父任务下面，可以折叠；看板、注意力、通知照常。

### 工具
所有工具按调用方的会话定作用范围，只能看到、动到自己的子任务。

| 工具 | 做什么 | 出处 |
|---|---|---|
| `aiwb_capabilities` | 能用的 Agent 和模型目录，以及调用方自己的 Agent、模型、权限档位 | t3code `orchestrator_capabilities` |
| `aiwb_subtask_create` | 开一个或一批子任务（Agent、模型、选项、工作树、首条消息），立刻返回 | Claude Code 嵌套会话、t3code `delegate_task` |
| `aiwb_subtask_list` | 子任务的标题、Agent、注意力状态、最后一条预览、分支 | t3code `task_status` |
| `aiwb_subtask_read` | 分页读子任务时间线，默认只有用户消息、回答和计划 | t3code `t3_thread_read` |
| `aiwb_subtask_send` | 追加消息，`mode` 取 `auto`（跟子任务自己的排队/引导设置）或 `steer` | t3code `t3_thread_send` |
| `aiwb_subtask_interrupt` | 打断子任务正在跑的回合 | t3code `task_cancel` |

- 首条消息要能单独看懂（做什么、哪些文件、做到什么算完），子任务不带父任务的对话。
- 子任务在 `needs-input` 时 `aiwb_subtask_send` 报 `blocked`，不替用户回答。出处：herdr `agent prompt` 的 `agent_blocked`。
- 父任务发给子任务的消息带 `sender`，子任务时间线里折成「来自 <父任务>」。

### 用户同意
`aiwb_subtask_create` 的 `initiation` 由 Agent 自己声明（出处：Claude Code 桌面版嵌套会话，产品行为，非源码）：

| `initiation` | 什么时候用 | 怎么开 |
|---|---|---|
| `user_asked` | 用户原话要求另开、后台跑或现在就开 | 直接开 |
| `offer` | 用户点了要做的事，但没说要另开 | 父任务时间线出卡片，Agent 等用户选「另开」或「就在这做」 |
| `own_initiative` | Agent 自己发现或提议的事 | 只出卡片，Agent 不等；一个回合最多 3 张，一周没点就过期 |

卡片列出 Agent、标题、首条消息摘要、是否开工作树；用户的选择按回报的路子送回父会话。

### 结果回报
出处：Claude Code 嵌套会话、t3code `DelegatedCompletionDelivery`。
- 父任务开完子任务可以直接结束回合。daemon 接 `Runtimes` 的状态通知，子任务每结束一个回合记一条待回报；所有子任务都不在 `working`、父会话也空闲时，用 `sessions.send` 一次发给父会话。
- 一条回报汇总所有待回报的子任务：标题、状态（`done` / `failed` / `needs-input`）、最后一条回答的前 400 字、工作树分支。`needs-input` 也回报，父任务据此让用户去处理。
- 回报正文要求父任务：告诉用户完成之前先读子任务结果或看 diff；合并几个子任务的改动先问用户，不推送分支。
- 以下情况不叫醒父会话，留到用户下一次发消息时一起带上：
  - 连续被回报叫醒多次、中间用户没发过消息（防止父子空转）；
  - 用户自己在子任务里发消息开的回合，被打断或失败的回合；
  - 用户在父会话里正在打字（30 秒内改过有字的草稿）或刚发了消息。
- 时间线里回报折成一行「来自 <子任务标题>」，点开看全文、点标题跳过去。用户消息事件的 `sender: {task_ids}` 标出来源；随用户消息带上的回报单独记一行，用户气泡只画用户写的。出处：t3code `TimelineUserMessageRow.tsx`。

### 安全规则
出处：t3code `OrchestratorMcpService.ts`。
- **权限不升级**：子任务档位缺省继承父任务，比父任务宽就拒绝（`read-only` < `ask` < `approve-for-me` < `full`）；父任务在计划模式时子任务也只能是计划模式。
- **调用方必须活着**：调用时调用方会话得正处在回合里。
- **重试幂等**：带 `clientRequestId` 时 daemon 在内存里记一段时间，重试直接返回上次结果。
- **只能动自己的子任务**：list、read、send、interrupt 都只认 `parentTaskId` 是调用方任务的子任务。
- 父任务只能发普通消息，斜杠命令（能改权限和模式）一律拒绝。

### 实现取舍
- `rmcp` 关掉会话模式、回 JSON，每个请求单独处理，daemon 重启不用恢复 MCP 会话。工具都很快返回，不拉长 `tool_timeout_sec`。
- 适配器没有强制排队的接口，`aiwb_subtask_send` 不单列 `queue`。
- 待回报只在内存里：daemon 重启后会话都记成已停止，没送出的回报不再送。
- 谁让子任务这一回合跑的按最后一次发消息的人算：用户在父任务开的回合里引导一句，这一回合就算用户的，不叫醒父会话；反过来也一样。
- 按子任务自己的设置排进队列的消息，等真正发出时由适配器记，不带 `sender`。
- 写给模型的文字（工具描述、返回值、报错、回报）统一用英文，错误码前缀不变；用户点卡片时看到的报错是中文。回报里的两条提醒只写在回报里，工具描述不重复。
- 权限上限按父会话存下的档位算。Codex 里用 `/permissions` 临时改的档位不写回会话选项，作曲栏里改的才算。
- Claude 的凭证在 `--mcp-config` 命令行参数里，同一用户的进程看得到。凭证只能动调用方自己的子任务、只在它的回合里有效；「子任务不能再开子任务」是工作台规则，不是安全边界。
- Cursor 原生也有 MCP，还没用真实 CLI 验证能否按会话注入，先不发凭证。
- 第一期不做：带上父任务对话开子任务（Claude Code 的 `fork`）、多层嵌套、操控平级任务、替用户回答审批或提问、给外部客户端用的 MCP。

## Agent 自带子 Agent

### 原生事件
- **Claude**（Claude Code 2.1.312）：实时 stream-json 里子 Agent 的消息只带 `parent_tool_use_id`，不带 `isSidechain`（转录文件里才有）。`Agent` 工具默认后台跑，工具结果当场返回 `async_launched`，之后发 `system` 事件 `task_started` / `task_progress` / `task_updated` / `task_notification`（带 `status`、`summary`、`usage`）。子 Agent 跑完 CLI 自己开新回合叫醒主 Agent。
- **Codex**（codex-cli 0.165.0，`multi_agent` 和 `multi_agent_v2` 报法一样）：派出只报 `subAgentActivity`（`kind = started`），结束是另一条 `subAgentActivity`（`kind = completed`）；`collabAgentToolCall` 只出现 `wait`，`receiverThreadIds` 和 `agentsStates` 为空，子线程不带派给它的说明。子线程的 `item/*`、`turn/*`、`thread/status/changed` 走同一条连接，`threadId` 是子线程。

### 实现
- **事件**（`crates/aiwb-core/src/timeline.rs`）：`subagent` 是一张卡片（`SubagentCard`），同一个 `subagent_id` 整条替换，适配器每次发全量；`subagent-step` 包着子 Agent 自己的一条回答、思考或工具调用，只和同一个子 Agent 的步骤合并。步骤是单独的事件，主时间线、交接、注意力预览都不当成主 Agent 的话。卡片 id：Claude 用派它的工具调用 id，Codex 用子线程 id。交接时卡片按「Subagent: 描述 + 结果」带上，步骤不带。
- **Claude**（`crates/aiwb-agents/src/claude/subagents.rs`）：`Agent` / `Task` 工具调用画成卡片；`task_*`（只认 `task_type = local_agent`）改卡片；前台的结果、模型、用量取工具结果的 `tool_use_result`。实时流按 `parent_tool_use_id` 区分主线和子 Agent，带它的消息转成步骤、不进主时间线（出处：t3code `ClaudeAdapterV2.ts`）。读转录时卡片来自主链，步骤读 `<会话 id>/subagents/agent-<agentId>.jsonl`，`origin.kind = task-notification` 的用户消息改卡片，不画气泡。
- **Codex**（`crates/aiwb-agents/src/codex/subagents.rs`）：本会话有线程 id 后，别的线程的通知一律不按主线程处理，已知子线程归到它的卡片下（`route_foreign_thread`），否则子线程的 `turn/completed` 会收掉主回合。主线程的 `subAgentActivity` 和 `collabAgentToolCall` 改卡片，标题取 `agentPath` 最后一段；子线程的完成条目转成步骤，最后一条回答当结果，`turn/completed` 失败或中断时改状态，`thread/tokenUsage/updated` 记用量。读历史时卡片留在原位置，再用 `thread/read` 读每个子线程补步骤、结果和 `agentRole` / `agentNickname`。
- **停掉**：进程退出或被停时还在跑的卡片记成已停止；daemon 启动时，上次没跑完的会话和还有后台子 Agent 的会话也这样记（`settle_interrupted`）。
- **注意力**（`crates/aiwb-core/src/attention.rs` 的 `on_subagent`）：会话已完成但还有卡片在跑时算「在做」，看板和侧栏不显示完成；空闲回收不收这样的会话。
- **界面**（`src/features/chat/events/SubagentGroup.tsx`、`subagent-display.ts`）：相邻卡片收成一组，组头「N 个子 Agent · 各状态个数」；卡片不算过程，回合收起时也留在外面。点开看说明、步骤、结果和用量，结果和最后一句回答相同时不重复。开发预览 `?preview=subagents`。出处：t3code `TimelineV2EventRow.tsx` 的 `V2SubagentGroup`、`subagent-display.ts` 的 `subagentGroupSummary`。

### 实现取舍
- 子 Agent 的过程在卡片内展开，不像 t3code 那样做成能单独打开的子会话（`ProviderSubagentBar.tsx`）。
- Codex 子线程的步骤不做流式，只取完成条目。
- 不用工具的 Claude 子 Agent，CLI 不一定把回答推到 stdout，这时只有卡片上的结果。

## 验证
- `cargo test -p aiwb-daemon --test subtasks`：假适配器走真实 HTTP。
- `cargo test -p aiwb-daemon --test subtasks_cli -- --ignored`：真实 CLI，Claude 开 Codex、Codex 开 Claude。
- `cargo test -p aiwb-daemon --test subagents_cli -- --ignored --nocapture --test-threads=1`：Claude、Codex 各并行派两个子 Agent，以及 Claude 后台子 Agent 跨 daemon 重开。

以上 2026-11-04 通过（Claude Code 2.1.312，codex-cli 0.165.0）。
