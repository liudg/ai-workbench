# 能力矩阵

首稿。格子只反映当前代码里的适配器、MCP surface 和动词，不是各 CLI 的官方能力说明书。

本文独立于 `AGENTS.md`。原生 CLI 以后有变，以代码和注释为准改表，不另附对照日志。

## 读法

| 标记 | 含义 |
| --- | --- |
| 已实现 | 能力开关为开，或会话方法覆盖了默认拒绝，并且有对应实现 |
| 关闭 | 开关为关，注释里写了原生不支持的证据 |
| 未接入 | `session_linked` 为假，`capabilities()` 是 `AgentCapabilities::none()`，`start_session` 拒绝开会话 |
| 未验证 | MCP 没有本机 CLI 验证过的驱动。动词全关。这不是「原生不支持」 |
| 未知 | 代码没有验证原生是否支持。未接入的会话能力都属这一类 |
| 空操作 | 方法用 trait 默认实现，直接返回成功，不把请求交给 CLI |

未接入的 Agent 不能开会话。表里会话相关的格子写「未接入」，原生是否支持一律未知，不把 `none()` 读成「CLI 没有这项」。

## 收录范围

设置页和探测用 `AgentKind::all`（`src-tauri/src/models/agent.rs`），七种：

| 显示名 | `AgentKind` | 适配器 |
| --- | --- | --- |
| Codex CLI | `CodexCli` | `src-tauri/src/features/agents/codex/mod.rs` |
| Claude Code | `ClaudeCode` | `src-tauri/src/features/agents/claude/mod.rs` |
| Cursor Agent | `CursorAgent` | `src-tauri/src/features/agents/external.rs` |
| Kimi Code | `KimiCode` | 同上 |
| Qwen Code | `QwenCode` | 同上 |
| OpenCode | `OpenCode` | 同上 |
| Antigravity | `Antigravity` | 同上 |

注册表在 `src-tauri/src/features/agents/mod.rs` 的 `adapter_for`。只有 Codex 和 Claude 的 `session_linked` 为真。`AgentKind::all` 就是全部种类。

## 会话与作曲

开关定义在 `src-tauri/src/models/catalog.rs` 的 `AgentCapabilities`。Codex 用 `AgentCapabilities::codex()`，Claude 用 `AgentCapabilities::claude()`，其余用 `none()`。

| 能力 | Codex | Claude Code | Cursor / Kimi / Qwen / OpenCode / Antigravity |
| --- | --- | --- | --- |
| 开会话 | 已实现 | 已实现 | 未接入 |
| 聊天（发送） | 已实现 | 已实现 | 未接入 |
| 流式输出 | 已实现 | 已实现 | 未接入 |
| 继续会话 | 已实现 | 已实现 | 未接入 |
| 历史回放 | 已实现 | 已实现 | 未接入 |
| 分页历史 | 已实现 | 已实现 | 未接入 |
| 停止当前回合 | 已实现 | 已实现 | 未接入 |
| 斜杠命令 | 已实现 | 已实现 | 未接入 |
| 计划模式 | 已实现 | 已实现 | 未接入 |
| 目标 | 已实现 | 已实现 | 未接入 |
| 暂停 / 继续目标 | 已实现 | 未实现 | 未接入 |
| 队列 | 已实现 | 已实现 | 未接入 |
| 图片 | 已实现 | 已实现 | 未接入 |
| 提问 | 已实现 | 已实现 | 未接入 |
| 审批 | 已实现 | 已实现 | 未接入 |
| 权限档 | 已实现 | 已实现 | 未接入 |
| 网络开关 | 已实现，菜单看 `config/read` | 关闭 | 未接入 |
| 额外可写目录 | 已实现，菜单看 `config/read` | 已实现 | 未接入 |
| 具名权限配置档 | 静态关，会话菜单探测后可开 | 关闭 | 未接入 |
| 替我批准 | 静态关，会话菜单探测后可开 | 关闭 | 未接入 |
| 模型与强度 | 已实现 | 已实现 | 未接入 |
| 服务档位 | 已实现 | 空操作 | 未接入 |
| 代码审查 | 已实现 | 关闭 | 未接入 |
| 技能 | 已实现 | 已实现 | 未接入 |
| 重命名 | 已实现 | 已实现 | 未接入 |
| 删除 | 已实现 | 已实现 | 未接入 |
| 归档 | 已实现 | 关闭 | 未接入 |
| 分叉 | 已实现 | 已实现 | 未接入 |
| 订阅用量 | 已实现 | 已实现 | 未接入 |
| 变更（回合 diff / 逐文件 / git 范围） | 已实现 | 已实现 | 未接入 |

Claude 的「暂停 / 继续目标」：`supports_goals` 为真，设置和清除目标已实现，但 `set_goal_status` 没有覆盖，会落到默认错误「这个 Agent 不能暂停目标」。

分叉：两个已接入适配器都实现了 `fork_thread`。侧栏菜单不提供这一项（`src/features/sidebar/sessions/session-menu.ts` 只有重命名、置顶、归档、删除）。

## MCP

动词在 `McpVerbs`（`src-tauri/src/models/mcp.rs`）。各 CLI 的面在 `src-tauri/src/features/agents/mcp/surface.rs`。驱动选择在 `adapter.mcp()`：Codex、Claude、Cursor 有驱动；Kimi、Qwen、OpenCode、Antigravity 返回 `None`，设置页用 `unverified`。

已安装才 `manageable`。未安装时动词结构仍按下表，但页面不可管理。

| 动词 | Codex | Claude Code | Cursor Agent | Kimi / Qwen / OpenCode / Antigravity |
| --- | --- | --- | --- | --- |
| 列表 `list` | 已实现 | 已实现 | 已实现 | 未验证 |
| 添加 `add` | 已实现 | 已实现 | 关闭 | 未验证 |
| 卸载 `remove` | 已实现 | 已实现 | 关闭 | 未验证 |
| 启用 `enable` | 已实现 | 关闭 | 已实现 | 未验证 |
| 禁用 `disable` | 已实现 | 关闭 | 已实现 | 未验证 |
| 登录 `login` | 已实现 | 已实现 | 已实现 | 未验证 |
| 取消认证 `logout` | 已实现 | 已实现 | 关闭 | 未验证 |
| 工具 `list_tools` | 关闭 | 关闭 | 已实现 | 未验证 |

补充（仍来自 surface，不是额外发明）：

- Codex：传输 STDIO、流式 HTTP。没有 scope。登录规则 `status`，状态 `notLoggedIn`。启用写 `config.toml` 的 `enabled`，没有 enable 子命令。
- Claude Code：传输 STDIO、SSE、HTTP。scope 为 local / user / project。登录规则 `http`。没有 enable / disable 动词。
- Cursor Agent：没有添加表单。登录规则 `always`（列表里没看到未登录状态，每一行都显示身份验证）。`list-tools` 有按钮文案「查看工具」。
- 未验证的四种：`manageable` 为假。已安装时文案是「已检测到 {名称}，暂无法在此管理 MCP。」未安装时是「未检测到 {名称}，安装后可在此管理 MCP。」

`notes` 只给测试留证据，界面不渲染。

## 安装与更新

探测和升级走 `AgentAdapter::installation` / `upgrade`（`src-tauri/src/features/agents/protocol/adapter.rs`）和 `src-tauri/src/features/agents/install/`。有 npm 包名时按安装位置在 npm 与 CLI 自更新之间选渠道；没有 npm 包名时，自更新子命令可用才标 CLI。

| CLI | 会话 | 可执行文件 | 更新命令 | npm 包 |
| --- | --- | --- | --- | --- |
| Codex CLI | 已接入 | `codex` | `update` | `@openai/codex` |
| Claude Code | 已接入 | `claude` | `update` | `@anthropic-ai/claude-code` |
| Cursor Agent | 未接入 | `agent`，其次 `cursor-agent` | `update` | 无 |
| Kimi Code | 未接入 | `kimi` | `upgrade -y` | `@moonshot-ai/kimi-code` |
| Qwen Code | 未接入 | `qwen` | `update` | `@qwen-code/qwen-code` |
| OpenCode | 未接入 | `opencode` | `upgrade` | `opencode-ai` |
| Antigravity | 未接入 | `agy`，其次 `antigravity`，最后 `gemini` | `update` | 无 |

OpenCode：安装方式认不出时，`opencode upgrade` 可能在终端里询问，应用内更新就不会成功（`external.rs` 的 `OPENCODE_NOTE`）。

Antigravity：只找到已停更的 `gemini` 时不在应用内更新（别名 `update_args` 为空）。

Cursor 的「更新」在本地 Agent 页可用（已安装且报告有更新时）。它没有会话协议。MCP 管理是另一条已验证路径，见上表。

## 依据

### 已接入的两种

Codex 会话方法在 `src-tauri/src/features/agents/codex/session.rs`：发送、队列、停止回合、审批与提问、权限、目录、模型与强度、服务档位、计划、目标（含状态）、审查、分页历史。流式事件在 `codex/rpc.rs` 的 `push_stream`。历史映射在 `codex/history.rs`（`thread/turns/list`，每页 20）。继续会话、重命名、删除、归档、分叉在 `codex/mod.rs` 和 `codex/resume.rs`。图片随 `deliver` 进回合输入。斜杠静态表在 `codex/catalog/input.rs`。权限档和探测后的配置档在 `codex/sandbox.rs`。`offline_permission_menu` 不含替我批准、网络和具名配置档。`refresh_sandbox_features` 之后，`permission_profiles` 在探测成功时为真，`approve_for_me` 跟随功能开关 `guardian_approval`，网络开关和额外目录跟随 `config/read` 里有没有 `sandbox_workspace_write`。静态 `AgentCapabilities::codex()` 里具名配置档和替我批准仍是 `false`，注释写的是「探测前为 false」；网络和额外目录的静态开关是 `true`。

Claude 会话方法在 `src-tauri/src/features/agents/claude/session.rs`。启动参数含 `--output-format stream-json` 和 `--include-partial-messages`（`claude/command.rs`）。历史在 `claude/history.rs`（`~/.claude/projects` 的 jsonl，分页 40）。图片在 `claude/images.rs`（本机 png / jpg / jpeg / gif / webp）。权限菜单在 `claude/permission.rs`（询问批准、跳过权限检查；网络关；额外目录开）。目标用 `/goal` 与 `/goal clear`。斜杠命令不在静态 profile 里，来自 CLI 初始化回包（`claude/catalog/mod.rs`）。关闭项的证据写在 `AgentCapabilities::claude()` 注释里：无 archive、无 `review/start`、无 `--network`、无具名配置档、无 `auto_review`。`set_service_tier` 与 `set_goal_status` 使用 trait 默认实现（`protocol/session.rs`）。

### MCP 驱动

- Codex：`src-tauri/src/features/agents/codex/mcp.rs`，surface 为 `mcp/surface.rs` 的 `codex`。
- Claude：`src-tauri/src/features/agents/claude/mcp.rs`，surface 为 `claude`。
- Cursor：`src-tauri/src/features/agents/mcp/mod.rs` 的 `CursorMcp`，surface 为 `cursor`。`add` / `remove` / `logout` 在驱动里拒绝。
- 其余已注册种类：`mcp/surface.rs` 的 `unverified`。

### 外部适配器

`src-tauri/src/features/agents/external.rs`：`capabilities` 为 `none()`，不覆盖 `session_linked`，`start_session` 因此返回未接入。`cli_release` 只提供探测和官方子命令更新。除 Cursor 外 `mcp()` 为 `None`。
