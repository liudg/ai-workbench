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

从 PR #72 的头（`cursor/fix-composer-diff-ux-dc0f`）接着搬。只拆模块、去掉没有调用点的代码，并把展示层的 store / IPC 收到 hook。不改已经验收的交互，不造数据。

更早一轮（PR #70）已经把协议类型、IPC、作曲栏、面板状态、会话日志和安装探测拆开。那些边界还在，这里不重复。

### 预览

- `preview/index.rs` 拆成 `index/mod.rs`（路径和正文缓存）、`index/scan.rs`（遍历）、`index/refresh.rs`（按修改时间作废缓存）。
- `preview/search.rs` 拆成 `search/mod.rs`（索引枢纽和命令）、`search/cursor.rs`（步进）、`search/mask.rs`（glob）。测试在 `search/tests.rs`。
- `preview/mod.rs` 只留命令。路径在 `path.rs`，文本在 `read.rs`，图片在 `image.rs`。
- `tree.rs` 删掉只被测试走到的 `filter_paths`。筛选测试改走生产的 `query_indexed_paths`。

### 死代码

- `ChangeCapabilities::git_only` 没有调用点，已删。`none` 和 `codex` 还在。
- `preview/browser.rs` 里只在 Windows 上收页面消息的函数标了 `cfg(windows)`。`parse_drained_messages` 测试也要用，所以是 `cfg(any(windows, test))`。标题、标注和截图命令在各平台都会进，没有删。非 Windows 的截图仍返回「截图不可用」。

### 展示层

这些文件不再自己调 `useWorkbench` 或 `backend`：`Workspace`、`RightPane`、`EmptyState`、`UpdateDialog`、`App` 外壳、图片查看器、文件预览壳、图片预览壳。数据走旁边的 hook 或 `preview-project.ts` / `image-file.ts`。`PanelProvider` 仍是面板边界，可以碰 store。关预览浏览器改走 `useCloseBrowserOnUnmount`。

### 其它按同一条边界拆开的模块

- 图片魔数和 base64 在 `images/preview_codec.rs`。聊天附件的路径校验留在 `images/mod.rs`。
- diff 的折叠在 `fold.ts`，正文过滤在 `diff-body.ts`。
- Codex 进程启动拆成 `process/proxy.rs`、`process/stderr.rs`、`process/bin.rs`。
- 模型目录拆成装配（`catalog/mod.rs`）、`models.rs`、`skills.rs`、回合输入和斜杠表（`input.rs`）。
- review / plan 的协议文本留在 `gap/mod.rs`，git 审查目标在 `gap/git.rs`，线程上的动作在 `gap/modes.rs`。
- `sessions/catalog`、`codex/host`、`codex/state` 的测试挪到同目录的 `*_tests.rs`。实现没动。

## 5. 没有 Codex 对应物、这一轮未改产品行为的功能

- **内置浏览器。** 地址栏、前进后退、原生 webview / iframe、本地文件页。Codex 桌面没有这套浏览器。
- **页面标注。** 标注模式、注释提交到当前会话。随浏览器保留。
- **多 Agent 安装探测。** 设置页列出已注册 CLI，未接入会话协议的种类保持「未接入」，不能新建会话。这不是 Codex 功能，也没有假接通。
- **`@` 文件候选。** 官方实验性 `fuzzyFileSearch` 是流式会话。作曲栏 `@` 查询沿用已有的 `filter_project_paths`（只返回文件，按相对路径匹配）。插入时的引号规则跟 Codex TUI：路径含空白且本身没有 `"` 才加引号。

## 6. 还没做，以及原因

下面这些文件仍超过约 10KB。再拆会把同一条协议、同一把锁或同一份 serde 模型切成没有独立含义的碎片，所以留在这里。字节数是这一轮结束时的文件大小。

| 债务 | 大小 | 原因 |
| --- | --- | --- |
| `agents/codex/turn.rs` | 37KB | 一条回合映射：发送、斜杠、目标、流式事件。目标快照的测试已经在文件后部，实现本身仍是一个所有者 |
| `agents/codex/history.rs` | 35KB | 一条历史回放映射 |
| `agents/codex/rpc.rs` | 32KB | 一条 app-server JSON-RPC 读写 |
| `sessions/manager.rs` | 32KB | 日志归并已经在 `log.rs`。打开、发送、排队、停止、改名共用同一把 `SessionEntry` 锁 |
| `agents/codex/sandbox.rs` | 31KB | 一条权限档位到 sandbox / approval 的映射 |
| `agents/codex/prompts.rs` | 29KB | 一条提问卡和 elicitation 映射 |
| `agents/codex/resume.rs` | 28KB | 一条 `thread/list` / `thread/resume` 目录 |
| `preview/browser.rs` | 28KB | 原生 webview 的显隐、标注和截图是同一块浏览器主机。网页预览不走这些命令 |
| `agents/install/mod.rs` | 25KB | 版本比较和进程捕获已经拆出。探测、选定二进制、检查和升级共用 `ChosenBin` |
| `sessions/log.rs` | 22KB | 一份会话事件日志。归并、流式替换和侧栏时间是同一个 `SessionEntry` |
| `agents/changes.rs` | 21KB | 一份 unified diff 解析。规则允许这种解析器留在一个文件里 |
| `agents/codex/tests.rs` | 19KB | 要本机 Codex CLI 的集成测试，仍标记为 ignore |
| `agents/codex/guardian.rs` | 19KB | 一条 auto-review 拒绝和 `/approve` 映射 |
| `agents/mod.rs` | 18KB | 适配器 trait、会话契约和错误类型。这是多 Agent 共用的那一层，不是某一种 CLI |
| `preview/page.js` | 15KB | 注进原生 webview 的一整段页面脚本，和 `browser.rs` 同一块主机。拆成模块要改注入方式 |
| `agents/codex/status.rs` | 17KB | 一条 `/status` 卡片文案 |
| `models/event.rs` | 15KB | 一份时间线 serde 模型，和前端事件一一对应 |
| `agents/codex/queue.rs` | 13KB | 一条 `thread/queue/*` 映射 |
| `agents/codex/host.rs` | 10KB | `/mcp` 和 `/hooks` 的解析与文案。测试已挪到 `host_tests.rs`，实现仍略超过 10KB |
| `agents/codex/session.rs` | 12KB | 一个 `AgentSession` 实现。进程和 RPC 已经在别的文件 |
| `models/catalog.rs` | 12KB | 一份能力、模型和安装结果的 serde 模型。`git_only` 已删，剩下的类型互相引用 |
| `agents/codex/mod.rs` | 12KB | 适配器编排：拉起进程、把 stdout / stderr 交给子模块。协议细节不在这里 |
| `useBrowserSession.ts` | 11KB | 原生 webview 和 iframe 还在同一个浏览器会话 hook 里 |

`Workspace`、`RightPane`、`EmptyState`、`UpdateDialog` 不再直接调用 `useWorkbench`。展示组件里的 `backend.` / `useWorkbench` 只剩 `PanelProvider`（规则允许的边界）。

审计时如果上面某一条已经不再成立，删掉对应行，不要留过期借口。
