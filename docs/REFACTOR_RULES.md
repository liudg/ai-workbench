# 重构规则与审计清单

后续改 AI Workbench 时按本文执行。规则来自已经约定的代码质量标准，不靠聊天记录。

## 1. 必须遵守

1. **模块归位。** 前端功能放在 `src/features/chat/`、`src/features/panel/{core,viewers,browser,diff,files}`、`src/features/changes-model/`、`src/shared/`。Rust 放在 `src-tauri/src/features/` 下对应模块。不要把一块逻辑留在不相关的目录里。
2. **文件不要过大。** UI 组件大约 10KB 就该拆。没有强理由（例如一份不能切开的解析器）时，更大的模块也要拆。
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
| 过大文件 | UI 超过约 10KB；Rust 模块明显混了两件不相干的事 |
| 展示层直连后端 | `.tsx` 里出现 `backend.`、`invoke(`、`useWorkbench`，且该文件是在渲染而不是 hook/provider |
| 跨功能深引用 | `shared/` import `@/features/`；`store/` import 某个 feature 的 UI；panel 子模块互相钻进对方的私有文件 |
| 写死 Codex | UI 或共享逻辑用 `agent === "codex-cli"` 决定能力，而不是 capabilities |
| 死代码 | 无引用 export、`allow(dead_code)` 且没有调用点、看得见但没有行为的控件 |
| 与 Codex 漂移 | 有官方 app-server / TUI 对应物，但本地另写了一套协议 |
| 假接通 | 返回写死的成功、空 diff、假会话 |

## 4. 这一轮做了什么

从 `main`（含 PR #70，`29b2965`）拉出。只搬代码，不改已经验收的交互。

### 协议按同一条边界拆开

前端 `src/types` 和 Rust `src-tauri/src/models` 都分成 agent、session、event、catalog。字段和 serde 名字没变，对外仍是 `crate::models::*` 和 `@/types`。

IPC 从 `lib/ipc.ts` 拆成契约（`contract.ts`）、DTO（`dto.ts`）和按领域分组的命令。`backend` 仍是这一组命令的合集。

### 状态机

- 回答 Markdown：块解析、行内解析、收起规则分开。`answer-markdown.ts` 只保留 `parseAnswer` 和原来的公开类型。
- 作曲栏：提交、按键、粘贴、斜杠和技能执行在 `composer-run.ts`；权限档位和模型选择在 `composer-access-run.ts`。目录和排队的加载在 `useComposerFeeds`，审查菜单的关闭在 `useReviewDismiss`。
- 面板状态从 `store/slices/panel.ts` 挪到 `features/panel/state`。打开目标的加载在 `panel-load.ts`，标签布局在 `panel-session.ts`。store 的组合根（`store/index.ts`、`store/types.ts`）引用这个状态模块，不引用面板 UI。
- 会话日志归并（`apply_body`、流式替换、更早历史、侧栏时间）在 `sessions/log.rs`。`manager.rs` 只留生命周期。
- Codex 会话契约在 `codex/session.rs`。要本机 CLI 的集成测试在 `codex/tests.rs`，仍标记为 ignore。
- 安装：版本比较在 `install/version.rs`，查找二进制和捕获输出在 `install/command.rs`。

### 展示层

侧栏这些组件不再调用 `useWorkbench`，改走旁边的 hook：`SessionRow`、`SessionList`、`NewSessionButton`、`ProjectItem`、`ProjectHeader`、`AccountMenu`、`Sidebar`。

### 浏览器关闭

`browser_close` 改成任意 Tauri `Runtime` 都能调用，并登记在桌面版和 dev bridge 共用的命令表里。有 `preview-browser` 子 webview 时关掉它，然后清主机状态。dev bridge 没有这个子 webview，调用结果是清状态并成功返回，不是空实现。其它需要原生窗口的浏览器命令仍只在桌面版注册。

## 5. 没有 Codex 对应物、这一轮未改产品行为的功能

- **内置浏览器。** 地址栏、前进后退、原生 webview / iframe、本地文件页。Codex 桌面没有这套浏览器。
- **页面标注。** 标注模式、注释提交到当前会话。随浏览器保留。
- **多 Agent 安装探测。** 设置页列出已注册 CLI。Codex 和 Claude Code 的会话协议已接入；其余种类保持「未接入」，不能新建会话。没有把未接入的种类假接通。
- **`@` 文件候选。** 官方实验性 `fuzzyFileSearch` 是流式会话。作曲栏 `@` 查询沿用已有的 `filter_project_paths`（只返回文件，按相对路径匹配）。插入时的引号规则跟 Codex TUI：路径含空白且本身没有 `"` 才加引号。

## 6. 还没做，以及原因

| 债务 | 原因 |
| --- | --- |
| `sessions/manager.rs`（约 32KB） | 日志归并已经在 `log.rs`。剩下的打开、发送、排队、停止、改名共用同一把 `SessionEntry` 锁，仍是一个所有者 |
| `agents/install/mod.rs`（约 25KB） | 版本比较和进程捕获已经拆出。探测、选定二进制、检查和升级共用 `ChosenBin`，仍是一条安装路径 |
| Codex 的 `history.rs`、`turn.rs`、`rpc.rs`、`sandbox.rs`、`prompts.rs`、`resume.rs` | 各自是一条协议映射或进程状态。这一轮只把会话契约和本机集成测试从 `mod.rs` 拆出去 |
| `preview/browser.rs`（约 28KB） | 原生 webview 的显隐、标注和截图是同一块浏览器主机。网页预览不走这些命令 |
| `Workspace.tsx`、`RightPane.tsx`、`EmptyState.tsx`、`UpdateDialog.tsx` 仍调用 `useWorkbench` | 侧栏行已经改走 hook。这四个是工作区屏幕，不是侧栏行 |
| `useBrowserSession.ts`（约 11KB） | 原生 webview 和 iframe 还在同一个浏览器会话 hook 里 |

审计时如果上面某一条已经不再成立，删掉对应行，不要留过期借口。
