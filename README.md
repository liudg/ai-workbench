# AI 工作台（AI Workbench）

一个**本地多项目 AI 编程工作台**：左侧管理多个本地项目，每个项目可并行开启多个 Agent 会话。Codex CLI 走本机 `codex app-server`，Claude Code 走本机 `claude` 的 stream-json 控制协议，Cursor Agent 走本机 `agent acp`（Agent Client Protocol）；其余 Agent 只做本机检测和官方更新，会话协议未接入，不能新建会话。右侧以时间线查看输出，并用同一套提问卡片处理审批、选择和问题。关闭窗口不会中断任何会话——应用驻留系统托盘，后台继续运行。

## 技术栈

| 层 | 技术 |
| --- | --- |
| 桌面壳 | Tauri 2（系统托盘、关窗驻留、原生文件对话框、自动更新 updater） |
| 后端 | Rust：常驻进程 `aiwb-daemon`（RPC、任务和会话服务、SQLite）+ `aiwb-agents`（适配器、能力）+ `aiwb-git` / `aiwb-files` |
| 前端 | React 18 + TypeScript + Vite + Tailwind CSS 4 + Radix/shadcn 风格组件 + zustand |
| 通信 | 前端经 WebSocket JSON-RPC 直连 daemon（调用 + 按主题订阅）；Tauri 命令只留应用壳的本机能力 |

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

v2 的界面只和后台 daemon 通信。网页预览时先手动启动 daemon，Vite 开发服务器读它写在数据目录里的 `daemon.json`，把地址交给页面：

```powershell
cargo run -p aiwb-daemon   # 后台服务，随机端口，地址和 token 写入数据目录的 daemon.json
pnpm dev                   # 打开 http://localhost:4573
```

桌面版不用手动启动：应用打开时会自动拉起 daemon，关掉窗口它也继续运行，从托盘退出时才一起停下。数据目录可用 `AIWB_DATA_DIR` 指定。系统文件对话框只在桌面版可用，网页预览里选目录改为手动输入路径。

## 发布与自动更新

应用内置自动更新（tauri-plugin-updater）：启动时静默检查，侧栏左下角头像菜单中的「检查更新」可手动检查；发现新版本后弹窗展示更新说明，点击「立即更新」自动下载、校验签名、安装并重启。**最终用户无需安装 Rust 或任何开发工具**，只需 NSIS 安装包。

发布链路（详见 [release/README.md](release/README.md)）：

1. **云端开发**：日常开发在本云仓库进行；
2. **Windows 构建**：Windows 安装包（NSIS）**必须在 Windows 机器上构建**——使用 GitHub Actions `windows-latest`（`.github/workflows/release-windows.yml` 已备好，推送 `v*` tag 即可）或 Cursor 私有 Windows worker；默认 Linux 云主机不能产出 .exe；
3. **签名**：构建时设置 `TAURI_SIGNING_PRIVATE_KEY`（私钥不入库；本项目的私钥在云端交付物 `artifacts/tauri-signing/`，公钥已内嵌 `tauri.conf.json`）；
4. **更新源**：仓库里还没有公开的 `latest.json`。`tauri.conf.json → plugins.updater.endpoints` 为空，`src/lib/update-source.ts` 的 `UPDATE_ENDPOINT` 也是空字符串，应用内检查显示「暂无可用更新源」。有真实 HTTPS 地址后，这两处写成同一个地址，再上传 `latest.json`（由 `scripts/gen-latest-json.mjs` 生成，模板见 [release/latest.json](release/latest.json)）和安装包；
5. **用户侧**：旧版本用户启动应用即收到更新提示，一键升级到新版。

## 架构总览

```
┌──────────── Tauri 应用壳（src-tauri/）────────────┐      ┌──────────── aiwb-daemon（crates/）────────────┐
│ daemon.rs     拉起或连接 daemon，把地址交给前端    │      │ server / connection  WebSocket JSON-RPC + token │
│ attention.rs  订阅注意力：系统通知、任务栏角标      │      │ services/   项目、任务、会话、文件、Git、导入… │
│ tray.rs       托盘（显示主窗口 / 退出）            │      │ runtime     接上 Agent、归并事件、写库、推送   │
│ features/     本机打开、内置浏览器、时间线图片      │      │ aiwb-store  SQLite（唯一数据源）               │
└──────────────────────────────────────────────────┘      │ aiwb-agents Codex / Claude / Cursor 适配器     │
┌──────────── 前端（src/）─────────────────────────┐      └──────────────────────────────────────────────┘
│ lib/daemon    连接、RPC、订阅、主题缓存 ──────────┼── WebSocket ──▶
│ lib/native    应用壳的本机能力（invoke）           │
│ features/     侧栏、会话视图、看板、面板、设置…    │
└──────────────────────────────────────────────────┘
```

网页预览和桌面版走同一条 WebSocket；网页预览没有应用壳，本机打开、内置浏览器、粘贴图片这些不可用。

### 事件流（一条消息的生命周期）

```
前端 sessions.send
  → daemon 写一条 UserMessage 事件，交给会话运行时
  → 运行时按需接上 Agent（已停止的用 resume 接回原线程），AgentSession 发出这一轮
  → 适配器经 EventSink 推送 SessionEventBody（AgentMessage / ToolCall / Prompt / StatusChanged…）
  → 运行时归并流式事件，和注意力投影在同一个事务里写库
  → 推给订阅了 session:<id> 和 tasks 的连接，前端按 rev 补差 → 渲染
```

### 会话状态机

`running`（处理中）→ `needs-input`（有待答提问，界面内联展示审批卡）→ 回答后回到 `running` → `completed`（空闲，可继续发消息）。另有 `failed` / `stopped`。侧栏和看板的状态药丸取注意力投影（要你处理 > 运行中 > 已完成 > 空闲）。

### RPC 方法

| 分组 | 方法 |
| --- | --- |
| `projects.*` | `list` / `create` / `add` / `update` / `remove` / `setPinned` |
| `tasks.*` | `list` / `create` / `rename` / `archive` / `setPinned` / `remove` / `deletePreview` / `fork` / `switchAgent` |
| `sessions.*` | `send` / `interrupt` / `answer` / `stop` / `setOptions`，排队（`updateQueued` / `removeQueued` / `steerQueued` / `flushQueued`），目标、审查、页面批注、目录与权限菜单 |
| `files.*` / `git.*` | 差异、目录、筛选、搜索、读文件；分支读取、切换和创建 |
| `agents.*` / `mcp.*` | 能力、模型目录、安装与升级、订阅用量；各 Agent 的 MCP 管理 |
| `imports.*` / `drafts.*` / `settings.*` / `attention.view` | 导入 CLI 会话、作曲栏草稿、任务文件夹、正在看的任务 |

订阅主题：`tasks`（任务列表和注意力）、`session:<id>`（时间线，按 `fromRev` 续传）。

## 多 Agent 边界

项目、任务、会话都以 daemon 的数据库为准，侧栏不扫描各 CLI 的目录。在终端里用 CLI 开的会话，从侧栏项目菜单「导入 CLI 会话」拉进来：按 Agent 分标签，滚到底部再取下一页。适配器的 `import_page` 只列工作目录是项目主目录的原生会话（Codex 是带 `cwd` 的未归档 `thread/list`，Claude Code 只读 `~/.claude/projects` 下这个项目的目录），已经导入过的不再列出。移除项目只改工作台列表，不删除 Agent 的 rollout，也不改写 Agent 自己的项目列表。

`SessionContext` 只保留通用字段：工作目录、权限档位、要恢复的 native id，以及 `options`。Codex 从 `options.persist` 决定新线程是否写入官方 resume 列表；行协议留在 `crates/aiwb-agents/src/codex/`。

适配器声明能力：`supports_slash`、`supports_resume`、`supports_questions`、`supports_tuning`、`supports_skills`、`supports_goals`、`supports_images`、`supports_queue`、`supports_cancel`、`supports_fork`、`supports_plan`、`supports_review`、`supports_network_access`、`supports_writable_roots`、`supports_permission_profiles`、`supports_approve_for_me`、`supports_paged_history`、`supports_subscription_usage`、`supports_context_handoff`。变更单独放在 `changes`：`turn_diff`（回合统一 diff）、`per_file_patch`（`file-change` / `turn-changes`）、`git_scopes`（未提交 / 未暂存 / 已暂存）。前端作曲栏、斜杠菜单和变更卡读 `agents.profiles`，不比较 `agent === "codex-cli"`。改名、归档、置顶、删除是任务层的事，由数据库处理，不要求 Agent 支持。工作树由任务层统一创建（分支 `aiwb/<id>`），Agent 只拿到 cwd。删除任务时，只清理工作台自己创建并记录过的工作树：干净就连目录和分支一起删；还有未提交改动或未合并提交时，先说明，让用户选择一起删除还是留下。用户自己的工作树和主检出不动。提问卡片由 `SessionEventBody::Prompt` 驱动。斜杠命令表在各 Agent 的 profile 里，不在前端放一张全局表。

Codex 实现拆在 `crates/aiwb-agents/src/codex/`：`mod.rs` 只编排，`rpc` / `prompts` / `catalog` / `process` / `resume` 各管一块。

设置页从侧栏左下角头像菜单进入，列出 `AgentKind::all` 里的每一种。新建会话只能选 `installed && session_linked` 的 Agent。项目行上只装了一个能开会话的就直接用它；「新建会话」主按钮始终打开选择菜单，菜单里不出现未接入的项。一个都没有时选择器说明原因。工作台不代为安装。

探测和更新都写在适配器的 `cli_release` 里。Codex 仍用自己的二进制查找，官方包是 npm 全局 `@openai/codex`，否则 `codex update`。Claude Code 若是 npm 全局安装则升级 `@anthropic-ai/claude-code`，否则执行 `claude update`。Cursor Agent 认 `%LOCALAPPDATA%\cursor-agent\agent.cmd`（其次 PATH 上的 `agent`），更新走 `agent update`。Antigravity 认 `%LOCALAPPDATA%\agy\bin\agy.exe`（其次 PATH 上的 `agy`，再其次 `antigravity`、`gemini`），更新走 `agy update`；只找到 `gemini` 或 `antigravity` 时能显示版本，但不能开会话，停更的 `gemini` 也不在应用内更新。其余种类在 `agents/external.rs`：

| 种类 | 命令 | 官方更新 |
| --- | --- | --- |
| Kimi Code | `kimi` | npm `@moonshot-ai/kimi-code`，或 `kimi upgrade -y` |
| Qwen Code | `qwen` | npm `@qwen-code/qwen-code`，或 `qwen update` |
| OpenCode | `opencode` | npm `opencode-ai`，或 `opencode upgrade` |

Gemini CLI 与 Antigravity 登记成一项，不做成两套会话。

**Codex、Claude Code、Cursor Agent 和 Antigravity 的会话协议已接入。** 其余适配器只做安装探测和官方升级，`start_session()` 走 trait 默认实现，直接返回「未接入」错误。设置页仍显示「未安装」或「版本 · 未接入」；新建会话菜单不列出它们。接入时实现 `AgentSession`，在适配器里覆盖 `start_session` 和 `session_linked`，要支持导入再实现 `import_list` / `import_history`；工作目录用 `ctx.project_path`。认证交给 CLI 自身，应用不保存密钥。Claude Code 的目录读 `~/.claude/projects` 里的 jsonl；Cursor Agent 读 `~/.cursor/acp-sessions/<id>/meta.json`，历史用 `session/load` 回放；Antigravity 用 `session/list` 和 `session/load`。Cursor 和 Antigravity 都走 ACP，共用 `agents/acp/`（收发、时间线映射、排队和设置），差别写在各自的 `Dialect` 里。

右侧「打开文件」按目录逐层列出当前项目根下的文件，没有全局数量上限。点文件在当前这一页里预览，不会为每次点击新开标签。全文搜索直接读本机目录，分段返回。目录名正好是 `.git`、`node_modules`、`target`、`dist`、`Library`、`Temp` 的文件夹不进入目录树，也不进入全文搜索；其余文件和文件夹都会列出。

## 常用命令

```powershell
pnpm dev             # 网页预览（需先 cargo run -p aiwb-daemon）
pnpm build           # 前端类型检查 + 构建
pnpm tauri:dev       # 桌面开发模式
pnpm tauri:build     # 打包
pnpm icons:gen       # 重新生成应用图标（scripts/gen-icons.mjs）
```

数据文件位置：`%APPDATA%\com.aiworkbench.app\workbench.sqlite`（Windows）。首次启动 v2 时会把旧版 `projects.json` 里的项目导入进来。
