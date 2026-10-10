# AI 工作台（AI Workbench）

一个**本地多项目 AI 编程工作台**的桌面应用骨架：在左侧管理多个本地项目，每个项目可并行开启多个 Agent 会话（第一波支持 Codex CLI 与 Claude Code），右侧以 Codex Desktop 风格实时查看会话输出、处理 Agent 发起的审批/提问。关闭窗口不会中断任何会话——应用驻留系统托盘，后台继续运行。

> 当前为 **v1 架构骨架**：项目/会话/事件/托盘全链路均已打通，Agent 适配器为**桩实现**（模拟流式输出与审批提问）。接入真实 CLI 只需替换适配器实现，上层无需改动。详见下文「v1 桩实现 vs 下一步」。

## 技术栈

| 层 | 技术 |
| --- | --- |
| 桌面壳 | Tauri 2（系统托盘、关窗驻留、原生文件对话框、自动更新 updater） |
| 后端 | Rust：`project_store`（JSON 持久化）+ `session_manager`（会话/事件总线）+ `agents`（适配器层） |
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
pnpm tauri:build    # 产出 NSIS 安装包 / 绿色 exe（src-tauri/target/release）
```

### 免 Rust 的浏览器预览

没有 Rust 环境也可以预览完整 UI（内置 mock 后端，行为与 Rust 桩一致）：

```powershell
pnpm dev            # 打开 http://localhost:4573
```

## 发布与自动更新

应用内置自动更新（tauri-plugin-updater）：启动时静默检查，侧栏底部「检查更新 vX.Y.Z」可手动检查；发现新版本后弹窗展示更新说明，点击「立即更新」自动下载、校验签名、安装并重启。**最终用户无需安装 Rust 或任何开发工具**，只需 NSIS 安装包。

发布链路（详见 [release/README.md](release/README.md)）：

1. **云端开发**：日常开发在本云仓库进行；
2. **Windows 构建**：Windows 安装包（NSIS）**必须在 Windows 机器上构建**——使用 GitHub Actions `windows-latest`（`.github/workflows/release-windows.yml` 已备好，推送 `v*` tag 即可）或 Cursor 私有 Windows worker；默认 Linux 云主机不能产出 .exe；
3. **签名**：构建时设置 `TAURI_SIGNING_PRIVATE_KEY`（私钥不入库；本项目的私钥在云端交付物 `artifacts/tauri-signing/`，公钥已内嵌 `tauri.conf.json`）；
4. **更新源**：把 `latest.json`（由 `scripts/gen-latest-json.mjs` 生成，模板见 [release/latest.json](release/latest.json)）与 `.nsis.zip` 上传到 GitHub Release 或任意 HTTPS 静态地址，并把 `tauri.conf.json → plugins.updater.endpoints` 中的 `OWNER/REPO` 替换为实际值；
5. **用户侧**：旧版本用户启动应用即收到更新提示，一键升级到新版。

## 架构总览

```
┌──────────────────────────── 前端（src/）────────────────────────────┐
│ App.tsx              左右布局 + 工作区路由                            │
│ components/Sidebar   项目列表（聚合状态点、活跃数、新建/导入/移除）     │
│ components/SessionTabs  会话标签页（状态点、Agent 徽章、停止）         │
│ components/ChatView  会话时间线（自动吸底滚动、运行中指示）            │
│ components/EventItem 事件渲染：用户气泡/Agent消息/工具卡/内联审批卡    │
│ components/Composer  输入框（有待答提问时自动转为「回答」通道）        │
│ store.ts (zustand)   状态 + 与后端双向同步；项目列表以重拉为唯一数据源 │
│ lib/ipc.ts           Backend 接口：Tauri 实现 / 浏览器 mock 双实现     │
│ types.ts             与 Rust models.rs 一一对应的 IPC 协议类型         │
└────────────────────────────────┬───────────────────────────────────┘
                                 │ invoke / listen
┌────────────────────────────────┴───────────────────────────────────┐
│                     后端（src-tauri/src/）                           │
│ commands.rs        全部 invoke 入口（参数 camelCase）                │
│ models.rs          Project / Session / SessionEventBody（IPC 协议）  │
│ project_store.rs   项目列表持久化 projects.json（app_data_dir）；     │
│                    建目录 + git init + 导入校验                      │
│ session_manager.rs 会话注册表；事件编号/落日志/广播；状态机推进        │
│ agents/mod.rs      AgentAdapter + AgentSession trait + EventSink    │
│ agents/codex_cli.rs    Codex CLI 适配器（桩）                        │
│ agents/claude_code.rs  Claude Code 适配器（桩）                      │
│ agents/stub.rs     桩会话：模拟流式输出 + 首轮审批提问                 │
│ tray.rs            托盘菜单（显示主窗口/退出）+ 单击唤起              │
│ lib.rs             组装；on_window_event 拦截关闭 → 隐藏到托盘        │
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
| `send_message` / `answer_prompt` | 发消息 / 回答提问（审批、选择、自由文本） |
| `get_session_events` | 拉取会话完整事件日志（切换会话时恢复时间线） |

## v1 桩实现 vs 下一步

**v1 已是真实模块**：适配器 trait、事件通道、会话管理、状态机、托盘驻留均为生产结构；`CodexCliAdapter` / `ClaudeCodeAdapter` 内部使用共享的 `StubAgentSession` 模拟「流式回复 → 工具调用 → 审批提问 → 等待回答 → 完成」全交互，便于先行打磨 UI 与状态流。

**接入真实 CLI 的位置**（每个适配器文件头注释也有说明）：

1. 为 `AgentKind` 新增或替换 `agents/` 下的适配器，实现 `AgentAdapter`：
   - `detect()`：执行 `<cli> --version` 探测安装与版本；
   - `start_session()`：在 `ctx.project_path` 启动真实进程。
2. 进程方案二选一：
   - **结构化输出**（首选）：如 `codex exec --json` / `claude -p --output-format stream-json`，用 `tokio::process::Command` 管道逐行读 JSONL，映射为 `SessionEventBody` 推入 `EventSink`；
   - **伪终端**：交互式 TUI 用 `portable-pty`，解析终端输出识别提问/审批界面。
3. 审批/提问经 `answer_prompt` 回写 CLI stdin（或对应协议），**不要在代码里写死任何密钥**——认证交给 CLI 自身（环境变量或其登录态）。
4. 可选增强：会话事件持久化（当前重启清空）、`failed` 错误路径展示、输出增量（delta）事件类型。

## 常用命令

```powershell
pnpm dev             # 仅前端（浏览器 mock 预览）
pnpm build           # 前端类型检查 + 构建
pnpm tauri:dev       # 桌面开发模式
pnpm tauri:build     # 打包
pnpm icons:gen       # 重新生成应用图标（scripts/gen-icons.mjs）
```

数据文件位置：项目列表持久化于 `%APPDATA%\com.aiworkbench.app\projects.json`（Windows）。
