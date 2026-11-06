# 多 Agent 协作体验调研

对象是 [agent-orchestration-mcp.md](agent-orchestration-mcp.md) 里的两件事：嵌套任务、Agent 自带子 Agent。那份文档写的是怎么实现的；这份只看用户用起来什么样，对照现成应用，定目标体验和验收办法。2026-11-05。

参考源码（本次从 GitHub 拉的浅克隆）：
- t3code `pingdotgg/t3code` 67eebac（2026-11-05）
- orca `stablyai/orca` 4353e32（2026-11-04）；实现时对照的是 7e99398f（2026-11-05），文中引用的文件两版都在
- herdr `herdrdev/herdr` ee5bfb5（2026-10-29）
- Claude Code 桌面版嵌套会话：产品行为，不是源码
- Cursor Agent 2026.10.22-27dcf5f 本机安装包 `3635.index.js`

## 起因：用户在正式包里试的四次

| 用户说的 | 看到的 | 原因 |
|---|---|---|
| 「开个嵌套会话做这个任务」（Codex） | 一张子 Agent 卡片，回答却说「嵌套会话已完成」；侧栏没有子任务 | 独立聊天拿不到工作台 MCP（`mcp::serves` 只给项目里的顶层任务），Codex 没有开子任务的工具，就用了自带的 multi_agent |
| 「调用子 agent 做这个任务」（Cursor） | 两组「已运行 N 条命令」，27 分钟后出一行白字 `Error: RetriableError: [canceled] http/2 stream closed…` | Cursor 从来不发 MCP（`mcpServers: []`）；Cursor 的原生子 Agent 没接；后端报错被 Cursor 当成回答文字发出来，工作台记成完成 |
| 子 Agent 卡片 | 一行「✓ animation gpt-6.1-terra · high 完成 · 1m 23s」，看不出是子 Agent；点了只在原地展开，内容很少 | 单张卡片不画组头、没有 Agent 图标；标题是 `agentPath` 最后一段；Codex 不报派发说明；设计上就没做单独打开 |
| 「调用 cursor 审查一下你的作品」（Codex） | 一条后台命令 `cursor-agent -p --mode ask …` 跑着，别的什么都没有 | 同第一条：没工具，Codex 只能用 shell 跑另一个 CLI。看不到过程、不能插手、结果只在命令输出里 |

四次都没碰到一个真正的嵌套任务。已经实现的那条路（项目里的 Codex/Claude 开子任务）用户根本走不到；走得到的路（原生子 Agent、shell 跑别的 CLI）又看不清。

## 要支持的场景

| # | 场景 | 用户典型说法 |
|---|---|---|
| S1 | 换个 Agent 做一件事 | 「让 Cursor 审查一下」「用 Claude 写测试」 |
| S2 | 另开一个会话做 | 「开个嵌套会话做」「后台另起一个做」 |
| S3 | Agent 自己派子 Agent | 不说，Agent 自己决定并行 |
| S4 | 看子任务/子 Agent 在干什么 | 盯着父会话，或点进去看 |
| S5 | 插手 | 打开子任务说一句、打断、停掉 |
| S6 | 结果回来 | 子任务完成、卡住要人、失败 |
| S7 | 回看 | 隔天打开、daemon 重启后打开 |

## 参考应用怎么做

### Claude Code 桌面版（嵌套会话）
- **谁都能开**：任何会话的 Agent 都有 `start_session`，不挑会话类型。
- **先说再开**：调用前在父会话写一行粗体标题加一句话说要做什么；`offer` 出卡片「New session / Do it here」，Agent 等用户选；`user_asked` 直接开；`own_initiative` 只出卡片，一周过期，一个回合最多 3 张。
- **开出来就是一个完整会话**：父会话里有一行能点开的会话行；侧栏里有它；可以拖到分屏和父会话并排看；用户能直接在里面说话、停掉它。
- **父 Agent 的计划**里，一步可以挂上这个会话，计划列表上直接显示它的实时状态。
- **回报**：子会话结束一个回合，父会话收到一条引用子会话最后汇报前 400 字的通知；父会话空闲且没有子会话在跑时才被叫醒；连着被叫醒很多次中间用户没说话，就攒着等用户。父 Agent 被要求先看结果或 diff 再告诉用户完成了。
- **上下文**：`fork`（带上整段对话）或 `fresh`（只带简报）由 Agent 定。

### t3code（委派任务 + 原生子 Agent）
- **两种来源，一套展示**：Agent 自带的子 Agent，和经 `delegate_task` 开的子任务，在数据上都是挂在父线程下的子线程（`packages/provider-core/src/server/subagentProjection.ts` 的 `makeSubagentChildThread`，`lineage.relationshipToParent = "subagent"`）。Codex、Claude、Cursor 的子 Agent 都投影成子线程（`packages/provider-cursor/src/server/adapter.ts` 里 `supportsSubagents: true`）。
- **父时间线**（`apps/web/src/components/chat/TimelineV2EventRow.tsx` 的 `V2SubagentGroup`）：一个子 Agent 也画组头「1 subagent」，前面叠着各子 Agent 所用 Agent 的头像，下面一行状态汇总，右边计时。展开后每行（`V2LifecycleRow.tsx`）是：头像、标题、实时进度或结果的一句话、状态、计时、`›`。**点整行直接打开子线程**；悬停出卡片，显示模型、状态、进度、结果（`SubagentTooltipContent.tsx`）。
- **标题**：有描述用描述，没有就用派发说明，最长 72 字；都没有才叫「<父标题> subagent N」（`subagentThreadTitle`）。Codex 只给 `agentPath`，也直接拿来当标题（`CodexAdapterV2.ts` 的 `registerSubagentActivity`）。
- **子线程视图**：和普通线程同一个时间线；作曲栏换成一条状态栏「Agent 图标 · 模型 · 强度 · 状态计时 · Runs on its own · Open parent」（`ProviderSubagentBar.tsx`）。
- **关系面板**：右侧面板列出这条线程的父线程（「Delegated from …」）、子 Agent、侧边聊天，能停、能打断、能合并回去（`ThreadRelationshipsControl.tsx`）。
- **侧栏**：子线程没有自己的行，打开子线程时高亮离它最近的、侧栏里有的祖先（`Sidebar.logic.ts` 的 `resolveSidebarRowThreadId`）。
- **工具引导**：`delegate_task` 的描述写明「只带 `task`，不带父对话；要单独检出就 `isolation:'worktree'`」；`task_status` 写明「它跑完会叫醒你，别在运行时去查」（`apps/server/src/mcp/toolkits/orchestrator/tools.ts`）。
- **Cursor**：走 Cursor SDK，每个线程注入自己的 MCP（`makeCursorAgentOptions` 的 `mcpServers`），并开 `enableAgentRetries: true`，后端可重试的错误由 Cursor 自己重试。
- **权限**：子任务档位不能比父任务宽，目标 Agent 不支持继承来的档位就降到它支持的最宽一档（`apps/server/src/mcp/delegatedTaskModes.ts`）。

### orca（编排 CLI + 可见终端）
- **入口是给 Agent 的 skill 加 CLI**：`orca orchestration send/check/dispatch/task-create/gate-create/run`（`src/main/skills/bundled-skill-install/orchestration-*.skill-md.txt`）。被派的 worker 就是一个跑着 Claude Code/Codex 的终端，用户随时能看到、能打字。
- **消息在对方空闲时送达**（push-on-idle）；worker 做完必须发 `worker_done`，卡住发 `escalation`，不能悄悄停着。
- **要人拍板的地方插决策门**（`gate-create`），任务停在 `blocked`，用户回答后带着答复继续派。
- **作曲栏上方一条「后台任务」条**（`src/renderer/src/components/native-chat/NativeChatBackgroundTasksStatus.tsx`）：按种类分组列出子 Agent 和后台命令，组头汇总个数，每行显示状态、名字和最后一句话，每行单独能停，也能全部停。侧栏的工作区卡片和这条用同一个行组件（`AgentChildRowContent.tsx`）。
- **嵌套层数**是设置项，默认 1 层：协调者派 worker，worker 不再派（`settings/orchestration/nested-worker-depth-copy.ts`）。

### herdr（另一个 Agent 就开在旁边窗格里）
- 给 Agent 的说明是 `skills/herdr/SKILL.md`。要另一个 Agent 时，默认在当前标签页里分出一个旁边的窗格（`pane split --current --no-focus`），在里面 `agent start reviewer --kind codex`，再 `agent prompt reviewer "…" --wait`。
- 被叫来的 Agent 就是一个完整的交互式 Agent，用户眼睛就能看到它在干什么，可以直接在那个窗格里打字。焦点留在调用方窗格。
- 对方卡在要人回答时，`--wait` 返回 `blocked`，调用方先 `agent read` 看清楚再决定，不盲目再发。

### 共同点
1. **被叫来的 Agent 一定是用户能直接打开、看到全过程、能插手的东西**：herdr、orca 是可见终端，t3code 是子线程，Claude Code 是会话。没有一家把它做成只能看摘要的黑盒。
2. **父会话里有一个持续更新、点一下就打开子任务的位置**：t3code 的子 Agent 行，Claude Code 的会话行，orca 的后台任务条。
3. **一眼能看出是另一个 Agent**：头像/图标、「subagent」字样、「Runs on its own」。
4. **能力随处可用**：哪个会话都能叫别的 Agent，不挑会话类型。
5. **卡住和失败会冒出来**：`blocked`、`escalation`、`needs-input` 都会回报到调用方，并且看得见。

## 我们现在

按代码走一遍用户路径：

| 场景 | 现在的表现 | 差在哪 |
|---|---|---|
| S1/S2 独立聊天里 | 没有工具。Agent 退回原生子 Agent，或者 shell 跑别的 CLI | 能力分会话类型，用户也不知道为什么不行 |
| S1/S2 父会话是 Cursor | 不发 MCP | Cursor ACP 的 `session/new`、`session/load` 收 `mcpServers`（`3635.index.js`），支持按会话注入，只是没做 |
| S1/S2 项目里的 Codex/Claude，`user_asked` | 父时间线只有一条 MCP 工具调用，折在「已运行 N 条」里；子任务只出现在侧栏 | 父会话里没有一行能看到子任务状态、能点开的东西 |
| S1/S2 `offer` | 卡片选完就没了，后面同上 | 卡片应该变成那一行子任务 |
| S3 Codex 子 Agent | 单张卡片没有组头、没有 Agent 图标，标题是 `agentPath` 最后一段；点了原地展开，没有说明、过程只有完成条目 | 看不出是子 Agent；不能单独打开；可能是空的（下面「待验证」第 3 条） |
| S3 Claude 子 Agent | 同上，但有说明和过程 | 不能单独打开 |
| S3 Cursor 子 Agent | 完全看不到 | Cursor 只在 `initialize` 声明了 `clientCapabilities._meta.subagents` 时才发 `subagent_spawned` / `subagent_state_update`；我们没声明，适配器也没处理 |
| S4 | 子任务只有侧栏一行；子 Agent 只有卡片 | 父会话里看不到子任务在干什么 |
| S5 子任务 | 能从侧栏打开、能说话、能打断 | 父会话里没有入口，也没有全部停 |
| S6 | 回报折成一行「来自 <子任务>」 | 基本对齐；但子任务里 Cursor 的 `Error:` 回答会被当成 `done` 报回去 |
| 出错 | Cursor 把后端异常 `\n\nError: …` 当回答文字发出，`session/prompt` 正常结束 | 记成完成，白字不是红条；也没有重试 |

## 目标体验
下面 10 条 2026-11-05 都已实现，实现见 [agent-orchestration-mcp.md](agent-orchestration-mcp.md)，验收见文末。「我们现在」一节保留的是实现之前的样子。

### P0：先让这条路走得通
1. **哪个会话都能开子任务。** 独立聊天也发 MCP，子任务挂在这个聊天下面，用同一个目录；侧边聊天和子任务自己还是不发。Cursor 经 ACP `mcpServers` 注入。
2. **工具描述写明**：要别的 Agent 做事就用 `aiwb_subtask_create`，不要用 shell 去跑别的 Agent 的 CLI。
3. **父时间线有一行子任务。** 开出来（`user_asked`，或者 `offer` 选了「另开」）就在原地放一行，照 t3code 的子 Agent 行：Agent 图标、标题、状态、计时、最新一句活动或结果、`›`；点整行打开子任务。状态跟着子任务走，`needs-input` 用琥珀色。`offer` 卡片选完就变成这一行。
4. **Cursor 的报错算失败。** 回合里出现 `\n\nError: ` 开头的尾段，就记成失败、显示红条，回报也报 `failed`。另外查 ACP 有没有对应 `enableAgentRetries` 的开关。

### P1：子 Agent 看得清、点得进
5. **一张卡片也画组头**：「Codex 子 Agent」加上 Agent 图标，让人一眼知道这是另一个 Agent。
6. **点一行就打开子 Agent 自己的视图**，不再原地展开：用和会话一样的时间线，作曲栏换成状态栏「Agent · 模型 · 强度 · 状态计时 · 独立运行 · 回到父会话」（照 t3code `ProviderSubagentBar.tsx`）。只能看不能发，原生子 Agent 本来就不能插话。悬停出卡片：说明、进度、结果。
7. **接上 Cursor 原生子 Agent**：声明 `_meta.subagents`，处理 `subagent_spawned` / `subagent_state_update` 和子会话的更新。
8. **修 Codex 子线程通知比 `subAgentActivity started` 先到时被丢的问题**（先验证会不会发生）。

### P2：多个一起跑时好管
9. **作曲栏上方一条「子任务和子 Agent」条**（照 orca `NativeChatBackgroundTasksStatus.tsx`）：有在跑的就出现，每行能停，也能全部停；点一行打开它。
10. **子任务能放到分屏**，和父会话并排看（Claude Code 的分屏，herdr 的旁边窗格）。

### 保持不变
- `initiation` 三种开法、回报规则、权限不升级、只能动自己的子任务，都已经对齐 Claude Code 和 t3code。
- 一层嵌套，和 orca 的默认值一样。

## 验收
每条都在**正式包**里从头走，Codex、Claude、Cursor 各走一遍。截图存证，界面和参考应用不一样的地方要写明原因。

| # | 操作 | 应该看到 |
|---|---|---|
| A1 | 新建独立聊天，对 Codex 说「开个嵌套会话做 X」 | 父时间线出现一行子任务，侧栏里挂在这个聊天下面；点这行打开子任务，里面在跑 |
| A2 | 同上，对 Cursor 说 | 同 A1 |
| A3 | 对 Codex 说「调用 Cursor 审查一下你的作品」 | 开出一个 Cursor 子任务，而不是一条 `cursor-agent` 命令 |
| A4 | 子任务跑完 | 那一行变成完成；父会话收到「来自 …」并据此回答 |
| A5 | 子任务要审批 | 那一行和侧栏都显示「需要你」；父会话收到 `needs-input` 回报，不替用户回答 |
| A6 | 子任务里 Cursor 后端报错 | 子任务显示红条、记成失败；父会话的那一行显示失败 |
| A7 | 让 Codex、Claude、Cursor 各自并行派两个子 Agent | 组头写着是哪个 Agent 的子 Agent；点一行打开它的视图，能看到说明（有的话）、过程、结果；「回到父会话」能回去 |
| A8 | 关掉应用再打开（daemon 重启） | 子任务行、子 Agent 视图都还在，状态对 |

## 验收结果（2026-11-05）
环境：release 版 `aiwb-daemon`（临时数据目录）加网页预览，和桌面版同一条 WebSocket 通道；Claude Code 2.1.312、codex-cli 0.165.0、Cursor Agent 2026.10.22-27dcf5f。截图存在本机 `%LOCALAPPDATA%\Claude-Data\claude_pzs8sxrjxfjjc\side-session-notes\local_15529b8c-13ba-46f6-b6b1-7033bb2a56ae\orchestration-shots\`（文件名以验收编号开头，没进仓库），真实 CLI 测试见 [agent-orchestration-mcp.md](agent-orchestration-mcp.md) 的「验证」。

| # | 结果 | 说明 |
|---|---|---|
| A1 | 通过 | 第一次没过：只靠工具描述时 Codex 听到「开个嵌套会话」用了自带的 `spawn_agent`。补上给会话的编排说明（Codex 走 `turn/start.additionalContext`）后，同一句话开出子任务；父时间线有子任务行，侧栏挂在聊天下面，点行打开子任务。真实 CLI 测试 `codex_chat_opens_a_nested_session_from_plain_words` |
| A2 | 通过 | Cursor 聊天同一句话开出 Cursor 子任务，用同一个文件夹（`cursor_chat_opens_a_nested_session_from_plain_words`、`cursor_chat_opens_a_codex_subtask`） |
| A3 | 通过 | Codex「调用 Cursor 审查一下」开出 Cursor 子任务，时间线里没有 `cursor-agent` 命令（`codex_asks_cursor_for_a_review_through_a_subtask`） |
| A4 | 通过 | 子任务那一行变成「完成」并显示结果；父会话收到「来自 …」后据此回答。Claude 做父会话开 Codex 子任务也一样 |
| A5 | 通过 | Codex 开的 Claude 子任务（`ask` 档）要运行命令：那一行和侧栏都是琥珀色「待批准」，运行中条也列出它；父会话收到 `needs-input` 回报，只提醒用户去处理，没有替用户批 |
| A6 | 通过 | 用只掐断 Cursor 后端连接的本地代理在子任务回合中途真实复现了 `Error: RetriableError: [canceled] http/2 stream closed…`：子任务红条、记成失败，父会话的那一行显示「失败」和报错。失败的回合按回报规则不叫醒父会话，等用户下一次发消息时带上，回报里是 `failed` |
| A7 | 通过 | Codex、Claude、Cursor 各派两个：组头写着「2 个 Codex CLI / Claude Code / Cursor Agent 子 Agent」，点行打开单独视图，「回到父会话」能回去。Claude、Cursor 的视图第一条是派发说明；Codex 原生不给说明（见待验证 4），视图里只有过程和结果 |
| A8 | 通过 | 正常关 daemon 再开，子任务行仍是「完成」，子 Agent 卡片和视图都在、状态对。顺带修了一处：Codex 适配器关进程时不管有没有回合在跑都记「已停止」，会把完成的子任务改成已停止；现在只在回合还开着时才记 |

另外验了：运行中条单独停一个子 Agent（Codex 打断子线程回合、Claude `stop_task`，主回合都接着跑）；子任务放进右侧面板和父会话并排（完整作曲栏）。

和参考应用不同的地方：
- 子任务行结束后只显示状态，不像 t3code 那样显示总用时：任务列表里没有每个回合的起止。
- Cursor 子 Agent 不能单独停（ACP 的 `session/cancel` 只认主会话），运行中条的「全部停止」改为打断主回合。
- 运行中条只列在跑和在等你的，不像 orca 那样短暂保留刚结束的几行。

## 待验证（结论）
1. **Cursor `mcpServers` 支持 HTTP**：`initialize` 回包 `mcpCapabilities: {http: true, sse: true}`；`3635.index.js` 按 `{name, type: "http", url, headers}` 解析（`headers` 收对象或 `[{name, value}]`），按会话加载。2026-11-05 用真实 CLI 让 Cursor 调到了工作台的工具。
2. **Cursor `_meta.subagents`**：`clientCapabilities._meta.subagents` 为 `true` 或任意对象即可（`types.ts` 的 `h`），回包的 `sessionCapabilities` 里多出 `subagents`。子 Agent 的过程确实是 `sessionId = subagentSessionId` 的 `session/update`；`subagent_spawned` 的 `task` 截到约 100 字，完整说明在前面 `Task` 工具调用的 `rawInput.prompt`。
3. **Codex 子线程通知会先到**：实录里子线程的 `thread/status/changed` 比主线程的 `subAgentActivity started` 早 1ms。已改成先存着、卡片出现时补上，不再丢。
4. **Codex 子线程没有派发说明**：实时通知里没有子线程的用户消息，`thread/read` 读回来也只有 `agentMessage`；只有 `agentPath`（如 `/root/a`）和 `source.subAgent.thread_spawn.agent_nickname`（如 `Dirac`）。标题只能继续用 `agentPath` 最后一段。

另查了 ACP 有没有对应 Cursor SDK `enableAgentRetries` 的开关：没有。print 和交互模式按动作类型打开重试，ACP 的 `session/prompt` 请求里不带这个字段，可重试的后端错误在 ACP 里不重试。

## 后续
- 验收时遇到的 Cursor 冷启动取不到模型目录（回空或 60 秒不回）已修：原因是网络抖动，和子 Agent、MCP 无关。适配器现在同一进程再取、卡住就换进程，到上限报清楚的错误（`crates/aiwb-agents/src/cursor/retry.rs`）。

## 已定（2026-11-05）
1. 原生子 Agent 改成点开单独视图（P1 第 6 条），替掉现在的原地展开。
2. 独立聊天开出来的子任务挂在这个聊天下面，用同一个目录。
