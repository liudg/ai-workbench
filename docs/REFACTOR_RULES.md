# 重构规则与审计清单

后续改 AI Workbench 时按本文执行。规则来自已经约定的代码质量标准，不靠聊天记录。

## 1. 必须遵守

1. **模块归位。** 前端功能放在 `src/features/chat/`、`src/features/panel/{core,viewers,browser,diff,files}`、`src/features/changes-model/`、`src/shared/`。Rust 放在 `src-tauri/src/features/` 下对应模块。不要把一块逻辑留在不相关的目录里。
2. **按耦合和内聚拆模块。** 拆不拆看职责是否相关，不看文件有多大。同一件事、共用同一份状态的代码留在一起。两件不相干的事不要塞进一个模块。
3. **展示组件不直接碰后端或全局 store。** 不在展示组件里 `invoke`、调 `backend.*` 或 `useWorkbench`。数据进出走该功能自己的 hook / service。`PanelProvider` 这类边界可以碰 store。
4. **不跨功能深引用，不复制同一份状态或 UI。** `shared/` 不能依赖某个 feature。store 不能依赖某个 feature 的 UI 模块。
5. **不把产品写死成 Codex。** 共享能力走适配器 trait、capabilities 和归一化事件。新的预览类型走 viewer registry。多 Agent 共用的功能走适配器层。
6. **删掉死代码。** 不留兼容垫片、看得见但没接上的控件、没人用的 export。
7. **Codex 对齐。** 自己实现、且 openai/codex（含 tui/utils）里有对应物的功能，必须跟官方逻辑和已有的 app-server API。偏了就改回去。Codex 没有的功能留下来，并在本文第 5 节登记。
8. **不造假。** 不写假返回、空实现冒充已接通。没接线就明确是没接线。

## 2. 不要做

- 只改 `liudong-dev/ai-workbench`。不要动 Unity、mercury_dev 或 Codex 上游树。
- 不为了整理代码去改已经接受的产品交互。搬代码不能带来视觉回归。
- 不在这类重构里打 Windows 安装包。

## 3. 审计清单

扫 `src/` 和 `src-tauri/src/` 时按下面逐项记。有命中就写路径，不要只写「看起来还行」。

| 检查 | 怎么看 |
| --- | --- |
| 模块放错 | 功能实现不在第 1 条列出的目录里，或会话目录文件里塞了回合映射 |
| 模块耦合 | 一个文件里混了两件不相干的职责，或把同一职责、同一份状态拆进互不相关的模块。不按文件大小判断 |
| 展示层直连后端 | `.tsx` 里出现 `backend.`、`invoke(`、`useWorkbench`，且该文件是在渲染而不是 hook/provider |
| 跨功能深引用 | `shared/` import `@/features/`；`store/` import 某个 feature 的 UI；panel 子模块互相钻进对方的私有文件 |
| 写死 Codex | UI 或共享逻辑用 `agent === "codex-cli"` 决定能力，而不是 capabilities |
| 死代码 | 无引用 export、`allow(dead_code)` 且没有调用点、看得见但没有行为的控件 |
| 与 Codex 漂移 | 有官方 app-server / TUI 对应物，但本地另写了一套协议 |
| 假接通 | 返回写死的成功、空 diff、假会话 |

## 4. 这一轮做了什么

从 `43fdf1c`（Claude 模型别名对齐）接着收。只搬近期目录、标签和会话目录接线留下的职责，不改作曲栏交互，不造数据。更早的预览、协议和 Codex 目录拆分还在，这里不重复。

### Claude 目录

- `agents/claude/catalog.rs` 拆成 `catalog/mod.rs`（initialize / list_models / get_settings 怎么写入一份目录）和 `catalog/models.rs`（模型行解析，以及 id → resolvedModel → label 的对齐）。`is_default` 只在对齐时写一次。
- 权限菜单挪到 `agents/claude/permission.rs`。它跟模型目录不是一件事。
- 线程模型的写入收成 `adopt_thread_model`。运行时不再自己改 `cli_config_read` 再调用对齐。

### 作曲栏

- 报告名对上哪一行模型、以及没手动选过时先看线程还是配置，在 `composer/model-selection.ts`。`composer-view.ts` 只拼这一屏的状态。
- 推理档短标签在 `effort-label.ts`（含「这个模型的当前档显示什么」）。滑杆几何和速度档留在 `model-picker.ts`。
- 汉字判断在 `choice-text.ts`，权限档和推理档共用。两张 id → 中文表仍各管各的。

### 死代码

- `cached_agent_catalogs` 没有调用点。它一次返回每个 Agent 的目录，界面不该拿来画。按会话取目录的 `agent_catalog` 还在，失败时仍只用这一 Agent 自己的缓存。

## 5. 没有 Codex 对应物、这一轮未改产品行为的功能

- **内置浏览器。** 地址栏、前进后退、原生 webview / iframe、本地文件页。Codex 桌面没有这套浏览器。
- **页面标注。** 标注模式、注释提交到当前会话。随浏览器保留。
- **多 Agent 安装探测。** 设置页列出已注册 CLI。Codex 和 Claude Code 的会话协议已接入；其余种类保持「未接入」，不能新建会话。没有把未接入的种类假接通。
- **`@` 文件候选。** 官方实验性 `fuzzyFileSearch` 是流式会话。作曲栏 `@` 查询沿用已有的 `filter_project_paths`（只返回文件，按相对路径匹配）。插入时的引号规则跟 Codex TUI：路径含空白且本身没有 `"` 才加引号。

## 6. 还没做，以及原因

下面这些留在一起，是因为职责相关：同一条协议、同一把锁，或同一份 serde 模型。再拆会切成没有独立含义的碎片。不按文件大小决定。

| 债务 | 原因 |
| --- | --- |
| `agents/codex/turn.rs` | 一条回合映射：发送、斜杠、目标、流式事件。目标快照的测试已经在文件后部，实现本身仍是一个所有者 |
| `agents/codex/history.rs` | 一条历史回放映射 |
| `agents/codex/rpc.rs` | 一条 app-server JSON-RPC 读写 |
| `sessions/manager.rs` | 日志归并已经在 `log.rs`。打开、发送、排队、停止、改名共用同一把 `SessionEntry` 锁 |
| `agents/codex/sandbox.rs` | 一条权限档位到 sandbox / approval 的映射 |
| `agents/codex/prompts.rs` | 一条提问卡和 elicitation 映射 |
| `agents/codex/resume.rs` | 一条 `thread/list` / `thread/resume` 目录 |
| `preview/browser.rs` | 原生 webview 的显隐、标注和截图是同一块浏览器主机。网页预览不走这些命令 |
| `agents/install/mod.rs` | 版本比较和进程捕获已经拆出。探测、选定二进制、检查和升级共用 `ChosenBin` |
| `sessions/log.rs` | 一份会话事件日志。归并、流式替换和侧栏时间是同一个 `SessionEntry` |
| `agents/changes.rs` | 一份 unified diff 解析，职责是同一件事 |
| `agents/codex/tests.rs` | 要本机 Codex CLI 的集成测试，仍标记为 ignore |
| `agents/codex/guardian.rs` | 一条 auto-review 拒绝和 `/approve` 映射 |
| `agents/mod.rs` | 适配器 trait、会话契约和错误类型。这是多 Agent 共用的那一层，不是某一种 CLI |
| `preview/page.js` | 注进原生 webview 的一整段页面脚本，和 `browser.rs` 同一块主机。拆开要改注入方式 |
| `agents/codex/status.rs` | 一条 `/status` 卡片文案 |
| `models/event.rs` | 一份时间线 serde 模型，和前端事件一一对应 |
| `agents/codex/queue.rs` | 一条 `thread/queue/*` 映射 |
| `agents/codex/host.rs` | `/mcp` 和 `/hooks` 的解析与文案是同一块主机状态。测试已挪到 `host_tests.rs` |
| `agents/codex/session.rs` | 一个 `AgentSession` 实现。进程和 RPC 已经在别的文件 |
| `models/catalog.rs` | 一份能力、模型和安装结果的 serde 模型。`git_only` 已删，剩下的类型互相引用 |
| `agents/codex/mod.rs` | 适配器编排：拉起进程、把 stdout / stderr 交给子模块。协议细节不在这里 |
| `useBrowserSession.ts` | 原生 webview 和 iframe 属于同一个浏览器会话 |

`Workspace`、`RightPane`、`EmptyState`、`UpdateDialog` 不再直接调用 `useWorkbench`。展示组件里的 `backend.` / `useWorkbench` 只剩 `PanelProvider`（规则允许的边界）。

审计时如果上面某一条已经不再成立，删掉对应行，不要留过期借口。
