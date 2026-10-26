# AI Workbench v2 架构设计

## 已定的方向
- 产品核心单位是**任务**，不是会话。首页是任务看板，聊天只是任务里的一个视图。
- 后台常驻进程持有 Agent，窗口关掉、应用更新或界面崩溃时 Agent 继续跑，靠托盘和系统通知提醒。
- 只给自己用：不做安装引导、账号、多语言。
- 技术栈不变：Tauri + Rust + React。
- 直接重构，不做回放测试；AGENTS.md 的 Codex 对标规则作废，重构完按新架构重写。

## 现状问题（重构的理由）
- **会话列表靠拼**：`SessionManager`（`src-tauri/src/features/sessions/manager.rs`）每次把各 CLI 的目录（Codex `thread/list`、`~/.claude/projects/*.jsonl`）和内存里的会话合并，工作树归属靠标记文件推断，状态来源不唯一。
- **事件只在内存**：`SessionEntry.events` 是一个 `Vec`，切会话时整份拉回，进程一退就没了，也没有断线后按 seq 续上的机制。
- **前端自己维护一大堆状态**：`src/store/slices/workspace.ts` 按会话 id 保存约 15 张 map，还有 `draft-session.ts` 和各种 epoch 防竞态。bug 主要出在这一层。
- **后端绑死在 Tauri 上**：命令都是 `tauri::command` 加 `State<SessionManager>`；网页预览靠 `tauri::test` 的 mock runtime 硬套（`dev_bridge.rs`）。
- **Agent 跟着应用进程**：应用一退或一更新，Agent 就断。

## 进程结构
```
┌──────────── Tauri 应用（壳） ─────────────┐        ┌────────────── aiwb-daemon ──────────────┐
│ 窗口 / 托盘 / 系统通知 / 内置浏览器 webview │        │ RPC 服务（WebSocket JSON-RPC，回环 + token）│
│ 启动或连接 daemon，把地址和 token 交给前端   │        │ 任务服务 / 会话服务 / Git / 终端 / 文件索引 │
│ React 前端 ── WebSocket ───────────────────┼──────▶ │ Agent 适配器：Codex、Claude、通用 ACP      │
└──────────────────────────────────────────┘        │ SQLite（唯一数据源）                       │
       网页预览：浏览器直接连 daemon，不再需要 mock    └────────────────────────────────────────┘
```
- **daemon 是独立的 Rust 二进制**，由应用拉起：已经在跑就直接连上，地址和 token 写在数据目录的 `daemon.json` 里。
- **前端直连 daemon**，桌面版和网页预览走同一条通道，`dev_bridge.rs` 可以删掉。
- **Tauri 壳只做原生能力**：窗口、托盘、通知、任务栏角标、内置浏览器。壳本身也作为一个客户端订阅注意力事件，用来发通知。
- **升级**：更新应用不影响 daemon。daemon 换新版时，等没有运行中的任务再重启；有任务在跑就提示"稍后重启"。
- **退出**：从托盘选"退出"时，没有运行中的任务就连 daemon 一起关；有任务在跑就二次确认。

## Cargo workspace
| crate | 职责 | 来源 |
|---|---|---|
| `aiwb-core` | 领域模型、归一化事件、能力结构体、状态推导（纯逻辑，无 IO） | 由 `models/`、`features/agents/protocol/` 迁移 |
| `aiwb-store` | SQLite（rusqlite）、迁移、读写事件日志和投影 | 新写 |
| `aiwb-agents` | `AgentDriver` 实现：codex、claude、acp | 迁移 `features/agents/{codex,claude,mcp,install}` |
| `aiwb-git` | worktree、checkpoint、diff、stage/commit/push/PR | 迁移 `features/git`，补新功能 |
| `aiwb-pty` | 终端（portable-pty），后端保存 scrollback | 新写 |
| `aiwb-daemon` | RPC 服务、订阅、服务装配、文件索引和搜索 | 新写，迁移 `features/preview/{index,search,tree}` |
| `src-tauri` | 应用壳 | 精简现有代码 |

## 领域模型（SQLite）
- `project`：id、path、name，以及项目配置（`.aiwb.json` 解析后缓存）。
- `task`：id、project_id、title、goal、workspace（`root` 或 `worktree{path, branch, base_ref, base_sha}`）、pinned、settled_at、archived_at、created_at。
- `session`：id、task_id、agent、native_id、model/effort/access 等选项、created_at。一个任务可以挂多个会话，用于扇出对比或中途换 Agent。
- `event`：(session_id, seq) 为主键，带 ts 和 body（归一化事件 JSON），只追加。
- `attention`：投影表，每个会话一行，字段为 state（needs_input / failed / working / done / idle）、unread、updated_at、last_message_preview。
- `checkpoint`：session_id、turn_id、git ref、sha。
- `terminal`：id、task_id、cwd、title；scrollback 存成文件。
- `draft`：task_id 对应的作曲栏草稿（文本、附件、选项），保存在 daemon，切任务、重启都不丢。

写入规则：一条事件的追加和受它影响的投影更新放在同一个事务里，提交后广播出去。单用户本地场景不需要 t3code 那套 command receipt 和 outbox。

## 会话来源
**已定**：工作台新建的会话以数据库为准。用纯终端 CLI 开的历史会话，通过"导入"拉进来，导入时用 CLI 的 resume 接管。侧栏不再每次扫描各 CLI 的目录。
- 代价：在终端里新开的会话不会自动出现在侧栏，要导入一下。
- 换来的：列表、状态、工作树归属都只有一个来源，现在大部分"状态对不上"的问题会一起消失。

## RPC 与同步
- **调用**：`{method, params}` 对应一个 service 方法，同一个方法同时供 UI、命令面板、快捷键和以后的本地 MCP 调用（"一个能力，所有入口"）。
- **订阅**：按主题订阅。
  - `tasks`：任务列表和注意力投影。
  - `session:<id>`：时间线，带 `from_seq`，断线重连只补缺的那段。
  - `terminal:<id>`：终端输出。
  - `git:<task>`：仓库状态。
- **前端**：一个连接客户端负责重连和续订；每个主题配一份查询缓存，界面直接读缓存。前端 store 只保留纯界面状态（布局、分屏、面板、选中项），不再按会话 id 保存业务 map。

## Agent 驱动接口
在现有 `AgentAdapter` 和 `AgentSession` 的基础上收敛。现有方法大多合理，保留；变化如下：
- `AgentDriver`：`capabilities()`、`catalog()`、`start(ctx) -> Runtime`、`resume(native_id, ctx) -> Runtime`、`import_list()`、`installation()` / `upgrade()`。
- `Runtime`：`send`、`steer`、`interrupt`、`answer_prompt`、`set_options(model, effort, access, mode)`、`stop`，可选 `rollback_turns`、`fork`、`compact`。每一项都有对应的能力开关。
- **去掉的**：`fork_thread`、`rename_thread`、`set_archived` 这类操作"原生线程目录"的方法。改名、归档、置顶是任务层的事，由数据库处理，不再要求每个 Agent 都支持。这样 Claude 现在缺的归档之类能力就不再是缺口。
- **工作树由任务层统一创建**（`aiwb-git`），Agent 只拿到 cwd。不再分成 Codex 自建检出和 Claude 传 `--worktree` 两套。
- **通用 ACP 驱动**：配置一条 `{kind, display_name, command, args, env}` 就能接入一个 Agent。Cursor、Gemini、Qwen、OpenCode、Kimi 等以注册表条目的形式加入，每一条都用真实 CLI 验证握手和能力后再启用。t3code 也是这么做的（`packages/provider-acp`、`provider-acp-registry`）。

## 前端结构
- `app/`：外壳、路由（看板 / 任务视图 / 设置）、分屏布局。
- `lib/daemon/`：连接、RPC、订阅、查询缓存。
- `features/board`：任务看板和注意力队列。
- `features/task`：任务视图，包括聊天、右侧面板（diff / 文件 / 终端 / 浏览器）和会话切换。
- `features/chat`：时间线和作曲栏，从现有代码迁移。
- `features/git`、`features/terminal`、`features/command-menu`、`features/settings`。
- **复用的现有代码**：Markdown 渲染（`shared/markdown`）、diff 渲染（`features/panel/diff`、`changes-model/diff-parse`）、时间线虚拟化（`chat/timeline/useTurnVirtualizer`）、作曲栏各菜单、命令面板的模糊匹配、审批卡和问题卡。
- **重写的**：`store/slices/*`、`draft-session.ts`、`lib/ipc/*`、侧栏（换成任务列表和看板）。

## 迁移步骤（新分支 `v2`）
1. **骨架** ✅（2026-10-23）：搭 workspace 和 daemon（RPC 加 WebSocket 加 SQLite 迁移）；Tauri 壳负责拉起和连接 daemon；前端连接客户端；把旧 `ProjectStore` 的项目导入数据库。
   - 完成标准：界面能列出项目。
   - 落地情况：`crates/aiwb-core`、`aiwb-store`、`aiwb-daemon`；壳侧 `src-tauri/src/daemon.rs`；前端 `src/lib/daemon/`、`src/features/projects/`。daemon 先复制到 `数据目录/daemon/<构建标识>/` 再运行，所以重新编译、安装新版都不会被正在运行的程序挡住；构建标识不一致时会自动替换 daemon。旧前端代码还在仓库里，入口已经切到新外壳，第 6 步删除。
2. **Codex 迁入** ✅（2026-10-26）：在任务和会话模型上跑通新建任务（目录或工作树）、对话、审批、排队和 steer、中断；复用时间线和作曲栏。
   - 完成标准：关掉窗口，Agent 继续跑；重新打开后从断开的 seq 续上，内容不丢。
   - 落地情况：旧的 `features/agents`、`features/git`、`models`、`encoding` 搬成 `aiwb-agents`、`aiwb-git`、`aiwb-core::models`、`aiwb-proc`，旧应用壳改为依赖它们。daemon 新增 `runtime.rs`（按需接上 Agent、归并流式事件、写库、推送）和 `tasks.*` / `sessions.*` 方法；`session:<id>` 主题按 `fromRev` 补差。daemon 重启后，上次没跑完的会话记成已停止，下一条消息用 resume 接回原线程，不重放历史。前端新增 `features/tasks`（侧栏任务列表）和 `features/task`（新任务、任务视图、作曲栏），聊天时间线通过 `ChatHost` 拿数据，不再读旧 store。
   - 任务视图补齐：代码审查菜单（`sessions.reviewTargets` / `startReview`）、粘贴和拖入图片（由应用壳存图并放进 WebView 可显示范围）、右侧差异面板。面板拆成通用的 `PanelHost`（界面状态来源 + 数据来源 `PanelData`）和旧工作区用的 `PanelProvider`；任务视图用独立的面板 store。差异、文件树、文件名筛选、正文搜索、文本和图片预览走 daemon 的 `sessions.diff*` / `listDir` / `filterPaths` / `searchFiles` / `readFile` / `readImage`，按会话的工作目录读；用系统程序打开、内置浏览器加载本地文件仍是应用壳的本机能力（`open_path` / `prepare_browser_path`，目录由前端带过去）；页面批注走 `sessions.submitAnnotation`。文件预览、目录、索引、搜索的代码搬进 `aiwb-files`，应用壳只留命令外壳。
   - 和设计的出入：事件表不是纯追加。流式覆盖改写同一 seq，每次写入换新的 `rev`，客户端按 rev 续传。
3. **Claude 迁入**：标准同上，再加上"从 CLI 历史导入会话"。
4. **看板和注意力**：注意力投影、看板、侧栏状态药丸、系统通知和任务栏角标（这一步把路线图阶段 1 的核心部分提前做了）。
5. **ACP 通用驱动**：先接一个能登录的 Agent 跑通完整对话，其他的只验证握手和能力。
6. **清理**：删除旧的 `SessionManager`、旧 store 和 `dev_bridge`，与旧 store 绑定的测试一并删掉或改写；按新架构重写 AGENTS.md。

步骤 2 完成后，v2 就已经能替代日常使用；之后的功能（diff 评论、checkpoint、终端、扇出）都在 v2 上做。

## 待确认
- 用来验证 Codex/Claude 的真实 CLI 在哪台机器上。
