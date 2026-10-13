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

从 `main`（含 PR #68，`6cc8af3`）拉出。

### 依赖方向

- `sandboxForAgent` 从作曲栏挪到 `src/lib/agents.ts`。建会话的 store 不再引用 `chat/composer`。
- 回答 Markdown 不再 import 聊天卡片、面板和图片组件。文件链接判断在 `shared/markdown/file-href.ts`。交互（打开文件、网站卡片、聊天图片）由 `workspace/AnswerMarkdownHost` 在已有 `PanelProvider` 的会话里接上。没有宿主时，http 图片仍是图片，本机路径只显示路径，不假装已经打开预览。
- 差异页和会话文件共用的筛选从 `panel/files` 挪到 `panel/core/file-filter.ts`。
- 源码按行拆分从 `diff/fold.ts` 挪到 `panel/core/source-lines.ts`。文本预览不再为了这个去引用差异折叠。
- 开发用差异预览不再写死 `agent="codex-cli"`。没有真实会话时 `agent` 为 `null`，不拿 Codex 能力表冒充。

### 展示层改为 hook

这些组件不再自己调 `backend` 或 `useWorkbench`：

- 浏览器：`useBrowserSession`，工具条在 `BrowserChrome`
- 工作区树：`useWorkspaceTree`
- 文件搜索：`useProjectFileSearch`
- 文件预览：`usePreviewFile`，读文件走 `readProjectText`
- 时间线滚动和翻页：`useTimelineFollow`；变更能力：`useChangeCapabilities`
- 提问回答：`useAnswerPrompt`
- 网站卡片标题：`useWebsiteTitle`
- 聊天图片：`useChatImage`
- 新建项目：`useNewProjectForm`
- 设置页本地 Agent：`useAgentSettings`
- 把文件附到会话：`useAttachFile`

差异工具条拆成 `DiffToolbar`、`DiffToolbarIcons`、`DiffOptionsMenu`、`DiffJumpPopover`。

### Codex 适配器

`agents/codex/resume.rs` 原先同时做三件事：列线程、把 `thread/turns/list` 映射成事件、目录进程上的 JSON-RPC。文件头写的是「本模块只负责列出线程」。

- 回合映射挪到 `agents/codex/history.rs`。实时 RPC（`rpc.rs`）、排队（`queue.rs`）和翻页（`turn.rs`）改为引用这里。
- 目录用的短命 app-server 客户端挪到 `agents/codex/directory_client.rs`。

映射行为没有改，原有历史单测跟着挪到 `history.rs`。

## 5. 没有 Codex 对应物、这一轮未改产品行为的功能

- **内置浏览器。** 地址栏、前进后退、原生 webview / iframe、本地文件页。Codex 桌面没有这套浏览器。
- **页面标注。** 标注模式、注释提交到当前会话。随浏览器保留。
- **多 Agent 安装探测。** 设置页列出已注册 CLI，未接入会话协议的种类保持「未接入」，不能新建会话。这不是 Codex 功能，也没有假接通。

## 6. 还没做，以及原因

| 债务 | 原因 |
| --- | --- |
| `shared/markdown/answer-markdown.ts`（约 25KB） | 一份 Markdown 解析器，拆开会把块解析和行内解析的状态机切开，没有第二个调用方需要单独演进 |
| `features/chat/composer/useComposerController.ts`（约 13KB） | 作曲栏提交、菜单和快捷键还是一条控制器。拆分会动已经验收过的输入行为，这一轮没有独立的第二个接缝 |
| `store/slices/panel.ts`、`lib/ipc.ts`、`types.ts` | 分别是面板状态、IPC 门面、与 Rust `models.rs` 对齐的协议类型。继续按字段拆会制造两份协议 |
| `src-tauri` 里 `sessions/manager.rs`、`models.rs`、`agents/install.rs`、`agents/codex/mod.rs` | 会话状态机、协议模型和安装探测各自仍是一块。`mod.rs` 后半是要本机 Codex 的集成测试。没有在不改行为的前提下拆出第二个所有者 |
| 侧栏行（`SessionRow`、`ProjectItem` 等）仍直接 `useWorkbench` | 它们是功能容器，不是这一轮最大的 IPC 耦合。改成逐个 hook 不会减少跨功能依赖 |
| `PanelProvider` 在卸载时调用 `backend.browserClose()` | 这是面板边界，不是展示组件。浏览器显隐仍由 `useBrowserSession` 负责 |

审计时如果上面某一条已经不再成立，删掉对应行，不要留过期借口。
