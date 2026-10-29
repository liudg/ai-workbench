# AI Workbench 借鉴 herdr / orca / t3code：分析报告与路线图

## Context
目前 AI Workbench 已经能把 Codex（app-server JSON-RPC）和 Claude Code（stream-json）接进同一个界面，对话、作曲栏、审批、diff 预览、浏览器、命令面板这些基础都有了。用户的反馈是：它"不像 AI 工作台，功能单一，bug 多"。本次参考三个同类热门项目，找出可以借鉴的功能，排好路线图，这一轮先不写代码。用户已确认可借鉴范围完全放开，Codex 桌面端没有的功能也可以纳入。

参考项目源码在 `Z:\workbench`。

## 三个参考项目各自的长处
| 项目 | 形态 | 核心思路 | 最值得借鉴 |
|---|---|---|---|
| herdr | Rust TUI 多路复用器 | 不包装 agent，只持有 agent 所在的 PTY | 五态状态检测与"注意力"排序；关闭客户端后 agent 继续运行；原生 resume |
| orca | Electron 编排器 | 一个任务对应一个 worktree 加一组 agent，扇出后择优合并 | Agent 看板、通知策略、后台创建 worktree、diff 逐行评论后批量发回、`orca.yaml` |
| t3code | Node 服务 + Web/Electron | 能力结构体驱动、事件溯源、执行与客户端分离 | 状态药丸优先级、隐藏 ref 做 checkpoint 和回退、智能 Git 按钮、上下文 chip、带 `when` 的快捷键 |

## 现状差距（盘点得出）
- **没有的**：终端/PTY、commit/push/PR、hunk 级 stage/revert、diff 评论、checkpoint 回退、系统通知/任务栏角标、多会话并排、侧栏搜索、快捷键自定义、项目级 setup 脚本、多 agent 扇出。
- **有但偏弱的**：状态只有一个状态点加"未读完成"；"下一个待处理"只有一条命令，没有队列视图；工作树创建会阻塞；Claude 能力缺口多（archive、review、斜杠命令表为空）；fork 菜单被隐藏，但命令面板里还留着入口。按 AGENTS.md 应该修正这种不一致。

## 可借鉴功能清单与路线图

### 阶段 0：架构重构（替代原来的"稳定性"阶段）
已完成（2026-10-28，`v2` 分支）。不先修零散 bug，也不做事件回放测试，直接重构：拆出后台 daemon，用 SQLite 做唯一数据源，引入任务模型，前端改成订阅后端投影。现在的 bug 大多来自状态来源不唯一，这一步会一起解决。

### 阶段 1：让它像"工作台"（多会话并行的基础）
1. **统一状态模型与注意力队列**（herdr + orca + t3code）
   - 归一化状态分为：needs-input（审批/提问）> failed > done-unread > working > idle-seen > unknown。后端从现有 `StatusChanged` 和 `Prompt` 事件推导，不做读屏。
   - 侧栏状态药丸借鉴 t3code `Sidebar.logic.ts` 的 `resolveThreadStatusPill`：颜色只用来表示"需要你看"，琥珀色是待审批，靛蓝是待输入，工作中用脉动。
   - 把 `src/features/attention/` 从"跳到下一个"扩展为一个可排序的队列，侧栏、命令面板空态、托盘角标都用它。
2. **系统通知**（orca `agent-attention-policy.ts`）：分"needs you"和"finished"两类；正在看的会话不提醒；有任务栏角标或闪烁；声音可选。用 Tauri notification 插件。
3. **Agent 看板**（orca `components/dashboard/`）：四列 Needs You / Working / Done / Idle，卡片显示最后一条消息预览，点卡片跳到对应会话。作为主区的一个视图。
4. **多会话并排**：主区支持 2 到 4 个会话分屏，或者把会话拖到边缘分屏（orca 的 pane 树）。
5. **跳转面板 Ctrl+J**（orca `WorktreeJumpPalette.tsx`）：空查询时按注意力顺序列出最近会话；输入时可以搜标题、分支、PR 号；Shift+Enter 在分屏中打开；`Ctrl+1..9` 直接跳到第 N 个会话（t3code）。

### 阶段 2：代码交付闭环（Git 与审阅）
6. **Checkpoint 与回退**（t3code `GitVcsDriver.ts:808-1170`）：每个回合结束时，用临时 `GIT_INDEX_FILE` 执行 `write-tree`、`commit-tree`，再 `update-ref refs/aiwb/checkpoints/<session>/<turn>`，不碰用户的 index 和分支。在 `TurnAnchor` 上提供"从这里回退"，可选只回退对话或连文件一起回退；目录被别的会话占用时拒绝。实现位置放在 `src-tauri/src/features/git/` 下新开的 checkpoint 模块。
7. **Diff 逐行评论后批量发回 Agent**（orca `components/diff-comments/`，t3code diff 评论 chip）：在 `src/features/panel/diff/` 加 gutter 评论，评论汇总成作曲栏里的上下文 chip，一次性发送。
8. **智能 Git 按钮**（t3code `GitActionsControl.logic.ts`）：根据仓库状态显示 Commit / Commit & Push / 开 PR / Pull；在默认分支上操作前二次确认；提交信息可以让当前 agent 生成。另外补上 hunk/文件级 stage、unstage、revert。PR 先只支持 `gh`。
9. **Turn diff 剔除 pull/merge 带进来的文件**（t3code `listAuthoredPaths`）。

### 阶段 3：工作区与终端
10. **内置终端**（t3code `terminal/Manager.ts`，herdr `src/pty`）：Rust 侧用 `portable-pty`，前端用 xterm.js；每个会话或工作树一个终端抽屉，支持多个 tab；scrollback 保存在后端，重新连接时恢复；选中的终端内容可以作为上下文 chip 发给 agent。
11. **项目配置文件**（orca `orca.yaml` / t3code `t3.json`）：例如 `.aiwb.json`，包含 setup 脚本（建 worktree 后运行，第一次运行需要用户批准）、需要共享或复制的 gitignore 目录、项目脚本（可以绑快捷键）。
12. **后台创建 worktree**（orca `worktree-create-*.ts`）：对话框立即关闭，侧栏显示进度行，支持取消和重试；第一次发 prompt 后，由 agent 按任务内容给分支改名。

### 阶段 4：作曲栏与导航打磨（t3code）
13. 上下文 chip：终端片段、diff 评论、引用的回答、浏览器标注（已有 `submit_annotation`，统一成 chip）。
14. 空输入框按 ↑ 调出历史 prompt；`Ctrl+S` 暂存 prompt；粘贴超过 32KiB 的文本时自动转成附件；把文件拖到侧栏的会话行上，直接附加到该会话。
15. 侧栏分区：置顶 / 活跃 / 已了结（PR 合并或长时间闲置后自动归入），所有操作支持 5 秒内撤销；增加侧栏搜索框。
16. 快捷键自定义（t3code `packages/shared/src/keybindings.ts`）：`keybindings.json` 支持 `when` 条件（如 `composerFocus && turnRunning`），文件变化时热加载并检测冲突；在设置里加一个分区。

### 阶段 5：多 Agent 编排（本项目的差异点）
17. **扇出**（orca / t3code 的 Shift 多选模型）：一个 prompt 发给多个 agent 或模型，每个各开一个 worktree；在一个对比视图里并排看结果和 diff，选中后合并。
18. **跨 Agent 交接**（t3code `ContextHandoffService.ts`）：在会话中途换 agent。不用 LLM 写摘要，而是按 token 预算挑选历史消息，并附上被省略部分的引用。已完成（2026-10-28）。
19. **Agent 互相驱动**（herdr `agent wait --until`，t3code Orchestrator MCP）：工作台提供一个本地 MCP，让一个 agent 能创建、等待、steer 其他 agent 的会话；目标处于 blocked 时拒绝注入输入。方案见 [agent-orchestration-mcp.md](agent-orchestration-mcp.md)（待确认）。Agent 自带子 Agent 的展示（含一个 Claude 子 Agent 回答混进主时间线的 bug）一起做，写在同一份文档里。
20. **会话 snooze 与定时任务**（t3code `scheduledTasks/`）。

### 暂不建议做
- 远程或手机端（herdr/orca/t3code 都有，但投入大）。
- herdr 那种读屏状态检测：本项目走结构化协议，用不到。
- 用量/费用页：已有用量计量，以后可以再扩展。
- 通用 ACP 驱动（2026-10-28 用户确认不做）：只用 Codex 和 Claude，两者走原生协议，功能接得比 ACP 深（额度、回退、原生分叉、审查）。t3code 也是主力 Agent 走原生、ACP 只接长尾（`apps/server/src/provider/builtInDrivers.ts`、`packages/provider-acp-registry`）。以后要用别的 Agent 再议。

## 架构落点
- 新的状态、checkpoint、终端、扇出能力，都加进 `AgentCapabilities`（`src-tauri/src/models/catalog.rs`）和归一化事件（`models/event.rs`、`src/types/event.ts`），前端只读能力开关。
- 新功能各自建模块（`features/terminal`、`features/checkpoints`、`features/dashboard`），展示组件通过 hook/service 取数据，不跨功能深层引用。
- 借鉴 t3code 的"一个能力，所有入口"：每个动作写成一个 service 方法，同时挂到 UI、命令面板和快捷键上。

## 验证方式（落地每一项时）
- 用真实的 Codex/Claude CLI 端到端跑一遍，对照能力开关逐项验证。
- 网页预览直接连 daemon，配合浏览器面板截图检查界面。
- 运行 `pnpm tsc`、前端测试、`cargo test`。

## 下一步
v2 重构已完成，后面按本路线图逐项做。
