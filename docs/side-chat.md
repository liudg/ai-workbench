# 侧边聊天

从当前对话临时分出一条来问，不打扰主线程。行为照 Codex 桌面端 / TUI 的 `/side`，入口照 Codex 桌面端新标签页的「侧边聊天 Ctrl+Alt+S」。

## 来源

- Codex `codex-rs/tui/src/app/side.rs`：
  - `side_fork_config`：`thread/fork` 带 `ephemeral: true`，沿用父线程的模型、强度、速度档和权限；
  - `SIDE_DEVELOPER_INSTRUCTIONS` 接在开发者说明后面，`SIDE_BOUNDARY_PROMPT` 用 `thread/inject_items` 插进历史；
  - `install_side_thread_snapshot`：继承的回合不显示，侧边聊天从边界开始；
  - `side_start_block_message`：同一个对话同时只开一个，再开就切过去；
  - `SideParentStatus`：侧边聊天开着时，主线程有变化（完成、失败、中断、等你处理）就在顶上提示；
  - `discard_side_thread`：关掉就丢，不能改名，不能找回。
- Codex `codex-rs/tui/src/app/thread_goal_actions.rs` `is_ephemeral_thread_goal_error`：临时线程没有目标。
- Claude Code 桌面端文档（code.claude.com/docs/en/desktop）：侧边聊天能读到主线程到那一刻的全部内容，不存盘，关掉应用后回不去。

## 本机验证（2026-11-02）

- Codex CLI 0.165.0：父线程回合进行中，另一个 `codex app-server` 进程 `thread/fork { ephemeral: true, excludeTurns: true, developerInstructions }`，再 `thread/inject_items`、`turn/start`，能答出父线程里的内容；`thread/list` 里没有这条线程。
- Claude Code 2.1.312：父会话回合进行中，另起进程 `--resume=<父> --fork-session --session-id=<新> --no-session-persistence --append-system-prompt <说明>`，`initialize` 后能连着问多轮，答得出父会话里的内容；`~/.claude/projects` 里没有新转录。

## 工作台里的做法

- 能力开关 `supports_side_chat`：Codex、Claude 开；Cursor 没有分叉方法，关。
- daemon：侧边聊天是任务下的一条会话，`session.side = 1`。不算任务的会话段，不改任务的标题和更新时间，任务列表里挂在 `side` 上。
  - `tasks.openSide`：开着的直接返回；否则从任务现在这段的原生会话分出来，CLI 在后台立刻接上（问的是打开那一刻的对话）。主对话还没发过消息、或者还有没交出去的交接前文时不能开。
  - `tasks.closeSide`：等正在接的 CLI 接完，再停进程，连时间线和没发的草稿一起删。归档、删除任务、换 Agent 时一起关。
  - 原生会话不落盘，CLI 退出后接不回去：空闲释放时（已完成、没人看着、没有排队）直接关掉；daemon 重启时清掉上次留下的。
  - 界面重载后面板标签没了：打开那个会话时发现侧边聊天开着却没有标签，就关掉它。
- 适配器读 `SessionContext.options.side_of`：Codex 见 `crates/aiwb-agents/src/codex/side.rs`，Claude 见 `claude/command.rs` 的启动参数。Claude 没有往历史里插消息的接口，Codex 的边界消息和开发者说明合成一段放进 `--append-system-prompt`。
- 界面：右侧面板的一个标签（`features/workspace/side-chat`）。入口有新标签页的「侧边聊天」、`Ctrl+Alt+S`（命令菜单「显示/隐藏侧边聊天」）、排队消息菜单的「在侧边聊天中打开」（发出去了才从主队列拿掉）。关标签就关侧边聊天。侧边聊天的作曲栏不能换 Agent。
