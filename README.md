# AI 工作台（AI Workbench）

一个**本地多项目 AI 编程工作台**：左侧管理多个本地项目，每个项目可并行开启多个 Agent 会话。Codex CLI 走本机 `codex app-server`，Claude Code 走本机 `claude` 的 stream-json 控制协议；其余 Agent 只做本机检测和官方更新，会话协议未接入，不能新建会话。右侧以时间线查看输出，并用同一套提问卡片处理审批、选择和问题。关闭窗口不会中断任何会话——应用驻留系统托盘，后台继续运行。

## 技术栈

| 层 | 技术 |
| --- | --- |
| 桌面壳 | Tauri 2（系统托盘、关窗驻留、原生文件对话框、自动更新 updater） |
| 后端 | Rust：`project_store` + `session_manager`（会话/事件总线）+ `agents`（适配器、能力、会话目录） |
| 前端 | React 18 + TypeScript + Vite + Tailwind CSS 4 + Radix/shadcn 风格组件 + zustand |
| IPC | Tauri commands（invoke）+ 事件广播（`session-event` / `sessions-changed` / `projects-changed`） |

## 在 Windows 上运行

### 环境准备

1. **Node.js 18+** 与 **pnpm**（`npm i -g pnpm`）
2. **Rust 稳定版**（[rustup.rs](https://rustup.rs)，需 1.77.2+）
3. **Microsoft C++ 生成工具**（Visual Studio Build Tools 的「使用 C++ 的桌面开发」工作负载）
4. **WebView2**：Windows 10/11 通常已内置，否则安装 [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)

### 启动

```powershell
pnpm install
pnpm tauri:dev      # 开发模式（前端热更新 + Rust 增量编译）
```

首次编译 Rust 依赖需要几分钟。窗口关闭后应用仍在系统托盘运行，右键托盘图标选择「退出」才会真正结束。

### 打包

```powershell
pnpm tauri:build    # 产出 NSIS 安装包，并复制到 release/（只保留当前版本）
```

### 网页预览（连真实后端）

网页预览不带任何模拟数据。浏览器经 Vite 代理 `/__bridge` 连本机 dev bridge，命令和事件都由同一套 Rust 后端处理，Codex 会话是真实的 `codex app-server`：

```powershell
cd src-tauri; cargo run --features dev-bridge --bin dev-bridge   # 监听 127.0.0.1:4574
pnpm dev                                                       # 打开 http://localhost:4573
```

没启动 dev bridge 时，界面会提示没有连上后端。内置浏览器、本机图片缩略图和系统文件对话框只在桌面版可用；网页预览里选目录改为手动输入路径。数据目录可用 `AI_WORKBENCH_DATA_DIR` 指定。

## 发布与自动更新

应用内置自动更新（tauri-plugin-updater）：启动时静默检查，侧栏左下角头像菜单中的「检查更新」可手动检查；发现新版本后弹窗展示更新说明，点击「立即更新」自动下载、校验签名、安装并重启。**最终用户无需安装 Rust 或任何开发工具**，只需 NSIS 安装包。

发布链路（详见 [release/README.md](release/README.md)）：

1. **云端开发**：日常开发在本云仓库进行；
2. **Windows 构建**：Windows 安装包（NSIS）**必须在 Windows 机器上构建**——使用 GitHub Actions `windows-latest`（`.github/workflows/release-windows.yml` 已备好，推送 `v*` tag 即可）或 Cursor 私有 Windows worker；默认 Linux 云主机不能产出 .exe；
3. **签名**：构建时设置 `TAURI_SIGNING_PRIVATE_KEY`（私钥不入库；本项目的私钥在云端交付物 `artifacts/tauri-signing/`，公钥已内嵌 `tauri.conf.json`）；
4. **更新源**：把 `latest.json`（由 `scripts/gen-latest-json.mjs` 生成，模板见 [release/latest.json](release/latest.json)）与 `.nsis.zip` 上传到 GitHub Release 或任意 HTTPS 静态地址，并把 `tauri.conf.json → plugins.updater.endpoints` 中的 `OWNER/REPO` 替换为实际值；
5. **用户侧**：旧版本用户启动应用即收到更新提示，一键升级到新版。

## 架构总览

```
┌──────────────────────────── 前端（src/）────────────────────────────┐
│ app/App.tsx          左右布局 + 工作区路由                            │
│ features/sidebar     已注册项目（可折叠；超过 8 条会话可展开）         │
│ features/chat        时间线、事件、作曲栏                            │
│ features/panel       差异、会话文件、内置浏览器、预览                 │
│ store/               zustand；项目列表以重拉为唯一数据源              │
│ lib/ipc.ts           Backend 接口；lib/transport.ts：Tauri / dev bridge │
│ types.ts             与 Rust models.rs 对应的 IPC 协议类型            │
└────────────────────────────────┬───────────────────────────────────┘
                                 │ invoke / listen
┌────────────────────────────────┴───────────────────────────────────┐
│                     后端（src-tauri/src/）                           │
│ features/ipc/      invoke 入口（参数 camelCase）                     │
│ models.rs          Project / Session / SessionEventBody              │
│ features/projects  项目列表 projects.json；建目录 + git init         │
│ features/sessions  会话注册表。项目只来自 projects.json               │
│ features/agents    AgentAdapter / AgentSession / 会话目录            │
│ features/git       未提交 / 未暂存 / 已暂存 diff                      │
│ features/preview   文本预览与内置浏览器                               │
│ tray.rs            托盘菜单（显示主窗口/退出）+ 单击唤起              │
│ lib.rs             组装；关窗隐藏到托盘                               │
└────────────────────────────────────────────────────────────────────┘
```

### 事件流（一条消息的生命周期）

```
前端 invoke send_message
  → SessionManager 记录 UserMessage（首条消息自动命名会话标题）
  → AgentSession.send_message（适配器，非阻塞）
  → 适配器经 EventSink 推送 SessionEventBody（AgentMessage/ToolCall/Prompt/StatusChanged…）
  → SessionManager 转发任务：编号 seq → 写入事件日志 → 更新会话状态
  → 广播 "session-event"（增量）与 "sessions-changed"（结构变化）
  → 前端按 id 去重合并 / 重拉会话列表 → 渲染
```

### 会话状态机

`running`（处理中）→ `needs-input`（有待答提问，界面内联展示审批卡）→ 回答后回到 `running` → `completed`（空闲，可继续发消息）。另有 `failed` / `stopped`（停止后会话归档、不可再发消息）。项目状态点取所有会话的聚合（待处理 > 运行中 > 失败 > 已完成 > 已停止）。

### IPC 命令

| 命令 | 说明 |
| --- | --- |
| `list_projects` / `create_project` / `import_project` / `remove_project` | 项目管理；create 支持选父目录建文件夹 + git init |
| `list_sessions` / `create_session` / `stop_session` | 会话生命周期（create 缺省用项目默认 Agent） |
| `send_message` / `answer_prompt` | 发消息 / 回答提问（审批、选择、自由文本、问题卡片） |
| `get_session_events` | 打开会话：已连接则返回日志，否则按目录里的 native id resume |
| `agent_profiles` / `agent_catalog` | 能力与斜杠命令（profile）；模型、推理强度和技能（catalog） |
| `list_agent_installations` / `update_agent` | 本机 CLI 探测与官方升级。适配器声明 npm 包或 CLI 自更新；设置页只渲染探测结果 |
| `set_session_access` / `set_session_tuning` | 权限档位；模型与推理强度 |

## 多 Agent 边界

会话管理器不持有 `CodexDirectory`。每种 Agent 注册一个 `SessionDirectory`：Codex 用 `thread/list`（与 `codex resume --all` 同一份交互、未归档列表）。会话协议未接入的种类不注册目录。侧边栏项目只来自工作台 `projects.json`。某个已注册项目下的会话，是这些目录里 cwd 对上该项目路径的并集，再加内存里已打开的会话，键是 `{agent}:{native_id}`。导入或移除项目只改工作台列表，不删除 Agent 的 rollout，也不改写 Agent 自己的项目列表。

`SessionContext` 只保留通用字段：工作目录、权限档位、要恢复的 native id，以及 `options`。Codex 从 `options.persist` 决定新线程是否写入官方 resume 列表；行协议留在 `agents/codex/`。

适配器声明能力：`supports_slash`、`supports_resume`、`supports_questions`、`supports_tuning`、`supports_skills`、`supports_goals`、`supports_images`、`supports_queue`、`supports_fork`、`supports_archive`、`supports_delete`、`supports_rename`、`supports_plan`、`supports_review`、`supports_network_access`、`supports_writable_roots`、`supports_permission_profiles`、`supports_approve_for_me`、`supports_paged_history`。变更单独放在 `changes`：`turn_diff`（回合统一 diff）、`per_file_patch`（`file-change` / `turn-changes`）、`git_scopes`（未提交 / 未暂存 / 已暂存）。前端作曲栏、斜杠菜单和变更卡读 `agent_profiles`，不比较 `agent === "codex-cli"`。提问卡片仍由 `SessionEventBody::Prompt` 驱动。斜杠命令表在 Codex 的 profile 里，含 `/mcp`、`/hooks`、`/goal`、`/worktree`，不在前端放一张全局表。

Codex 实现拆在 `agents/codex/`：`mod.rs` 只编排，`rpc` / `prompts` / `catalog` / `process` / `resume` 各管一块。

设置页从侧栏左下角头像菜单进入，列出 `AgentKind::all` 里的每一种。新建会话只能选 `installed && session_linked` 的 Agent。项目行上只装了一个能开会话的就直接用它；「新建会话」主按钮始终打开选择菜单，菜单里不出现未接入的项。一个都没有时选择器说明原因。工作台不代为安装。

探测和更新都写在适配器的 `cli_release` 里。Codex 仍用自己的二进制查找，官方包是 npm 全局 `@openai/codex`，否则 `codex update`。Claude Code 若是 npm 全局安装则升级 `@anthropic-ai/claude-code`，否则执行 `claude update`。后加的种类在 `agents/external.rs`：

| 种类 | 命令 | 官方更新 |
| --- | --- | --- |
| Cursor Agent | `agent`（别名 `cursor-agent`） | `agent update` |
| GitHub Copilot CLI | `copilot` | npm `@github/copilot`，或 `copilot update` |
| Kimi Code | `kimi` | npm `@moonshot-ai/kimi-code`，或 `kimi upgrade -y` |
| Qwen Code | `qwen` | npm `@qwen-code/qwen-code`，或 `qwen update` |
| OpenCode | `opencode` | npm `opencode-ai`，或 `opencode upgrade` |
| Goose | `goose` | `goose update` |
| Antigravity | `agy`，其次 `antigravity`，最后 `gemini` | `agy update`。只找到停更的 `gemini` 时不在应用内更新 |
| Kiro CLI | `kiro-cli`，兼容入口 `q` | `kiro-cli update --non-interactive`；只找到旧的 `q` 时用 `q update` |

Gemini CLI 与 Antigravity、Amazon Q 与 Kiro 各登记成一项，不做成两套会话。`q` 太容易和无关命令重名，版本输出里要出现 Kiro / Amazon Q，或者首行是 `q 1.2.3` 这种官方短版本，才算已安装。

**Codex 和 Claude Code 的会话协议已接入。** 其余适配器只做安装探测和官方升级，`start_session()` 走 trait 默认实现，直接返回「未接入」错误。设置页仍显示「未安装」或「版本 · 未接入」；新建会话菜单不列出它们。接入时实现 `AgentSession`，在适配器里覆盖 `start_session` 和 `session_linked`，再注册 `SessionDirectory`；工作目录用 `ctx.project_path`。认证交给 CLI 自身，应用不保存密钥。Claude Code 的目录读 `~/.claude/projects` 里的 jsonl。

右侧「打开文件」按目录逐层列出当前项目根下的文件，没有全局数量上限。点文件在当前这一页里预览，不会为每次点击新开标签。全文搜索直接读本机目录，分段返回。目录名正好是 `.git`、`node_modules`、`target`、`dist`、`Library`、`Temp` 的文件夹不进入目录树，也不进入全文搜索；其余文件和文件夹都会列出。

## 常用命令

```powershell
pnpm dev             # 网页预览（需先启动 dev bridge）
pnpm build           # 前端类型检查 + 构建
pnpm tauri:dev       # 桌面开发模式
pnpm tauri:build     # 打包
pnpm icons:gen       # 重新生成应用图标（scripts/gen-icons.mjs）
```

数据文件位置：项目列表持久化于 `%APPDATA%\com.aiworkbench.app\projects.json`（Windows）。
