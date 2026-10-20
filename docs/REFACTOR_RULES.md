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
9. **检查逻辑正确性。** 做封装对比、改动或审查代码时，不能只对比输入输出参数是否一致，还要检查适配层内部的逻辑：参数的优先级和覆盖关系（空值是否错误覆盖了配置值，例如 Codex `collaborationMode` 里的 `reasoning_effort: null` 覆盖了配置里的 effort）、模式切换时的行为分支、条件判断是否符合预期。
10. **能力开关只反映原生能力。** 适配器的能力开关只有在该 Agent 原生确实不支持时才能关闭。新增或修改任何 Agent 适配器时，必须逐项用真实原生 CLI 验证：支持的全部实现；关闭的项要在代码注释里写明原生不支持的证据（命令、帮助文字，或会话文件里确实没有）。

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
| 逻辑不正确 | 适配层里空值 / 默认值覆盖了配置值（如 `collaborationMode` 的 `reasoning_effort: null` 盖掉配置 effort）、参数优先级与 CLI 不一致、模式切换后走错分支、条件判断与预期不符。只比输入输出参数一致不算通过 |
| 能力开关无证据 | 关闭的 `supports_*` 没有注释写明原生 CLI 不支持；开了开关但没有对应实现；用工作台本地标记冒充原生能力 |

## 4. 这一轮做了什么

从 `a968e05`（0.2.80）接着收。只搬放错模块的职责、去掉展示层对 store 的直读，以及两处重复的失败文案。不改交互，不造数据，不拆第 6 节里同一条协议的文件。MCP 编辑和 Plan 模式没动。

### 侧栏开关

- 侧栏开合状态从 `sidebar/visibility.ts` 挪到 `shared/shell/sidebar-open.ts`。会话顶栏、侧栏和命令菜单都读这一份，面板不再钻进侧栏私有文件。
- `Ctrl+B` 的显示文字跟开合状态放在一起。命令菜单文案引用这一份，不再各写一遍。

### 命令菜单

- 打开事件从宿主组件里拆到 `command-menu/open-event.ts`。账号菜单只靠功能入口拿到事件和文案。
- 宿主组件不再调用 `useWorkbench`。项目、会话和目录从 `use-command-menu-state.ts` 进出。

### 打开文件顶栏

- 「打开」胶囊的下拉在 `OpenWithMenu.tsx`。顶栏只负责那一行。
- 搜索、Markdown 模式和外部打开的状态在 `use-file-preview-chrome.tsx`。预览列组件不再带着这份状态。

### 工作树开关

- `useSessionWorktree` 挪到 `use-session-worktree.ts`。按钮和标签不再直接问仓库有没有提交。

### 空仓库差异

- `git diff` 和没有提交时的未跟踪差异在 `git/diff.rs`。分支名和工作区探测留在 `git/mod.rs`。

### 开发预览

- 注意力预览和工作上下文预览写入 store 的代码分别在 `use-attention-preview.ts`、`use-work-context-preview.ts`。Plan 预览按这一轮的约束没动。

### 确认删除工作树的四个测试

在 git 2.43.0、Linux 上，这四个测试对 `a968e05` 的产品代码已经通过：`discard_confirmed_worktree` 会 `worktree remove --force`，锁定的再 `--force --force`，登记还在就删链接工作树的管理目录并 `worktree prune`。用同样的 git 命令手工删掉脏工作树、锁定工作树，以及先删 `.git/worktrees/<name>` 再 `prune`，`worktree list --porcelain` 都不再留下该路径；没有工作台记录的外部工作树仍在列表里。

失败断言 `worktree_listed` 原先用路径字符串做子串包含。分隔符、符号链接或主检出路径前缀都会让「还在不在列表里」判错。测试改成只认 `worktree ` 行，并按规范化后的路径相等。产品删除逻辑没有改。

### 看过、职责已经分开、没有再拆

- 重命名回车在 `rename-submit.ts`。会话行只调用它。
- 跳转弹窗的文件来源在 `jump-files.ts`，只使用当前范围正在显示的文件。
- 审查正文只在 `item/completed` 写入，仍在 `agents/codex/rpc.rs`。那是一条 JSON-RPC，见第 6 节。
- Ctrl+Enter 走哪条通道在 `composer-now.ts`。真正送出和逐条引导仍在 `composer-run.ts`，因为它们共用同一次作曲运行。
- 侧栏收起后的左缘滑出仍是 `SidebarPeek` 一件事。

## 4.1 上一轮留下的搬迁

从 `8a247f0`（0.2.53）接着收。只搬放错模块的职责、去掉重复解析和展示层对 store 的直读。不改交互，不造数据，不拆第 6 节里同一条协议的文件。

### 路径和标题

- 路径规范化从 `panel/files/path.ts` 挪到 `shared/path.ts`。聊天、差异和各个查看器都要用，它不依赖某个功能。
- 文件状态的颜色留在 `changes-model/status-tone.ts`。那是变更状态，不是路径。
- `<title>` 解析原先在浏览器和聊天卡各写一份。收成 `shared/html-title.ts`。

### 会话身份和置顶

- 适配器显示名、图标和 `SessionAgentIcon` 挪到 `shared/agent/`。侧栏和聊天气泡读的是同一份资料，不再从侧栏私有文件往外拿。
- 置顶 id 的读写挪到 `store/pinned-sessions.ts`，跟未读完成放在一起。store 不再引用侧栏模块。

### 展示层

- 项目行、会话列表、归档列表、工具行不再自己调用 `useWorkbench`。分别走 `useProjectItem`、`usePinnedSessionIds`、`useSessionProjectPath`。
- 开发预览写入资料的 `setState` 收到 `useActivityPreviewProfiles` 和 `useUsagePreviewProfiles`。
- `AnswerMarkdownHost` 挪到 `chat/answer/`。它接的是回答里的图片和网页卡。差异和活动预览页挪到 `app/preview/`，由应用壳组合，面板和聊天不再互相引用对方的预览页。

### 选区

- 选区菜单的手势和松开位置在 `shared/selection/`。文件行号仍在 `panel/viewers/`。写入会话文本片的函数放在 `panel/core/useAddTextSnippet.ts`，预览和聊天记录都从这里进。

## 5. 没有 Codex 对应物、这一轮未改产品行为的功能

- **内置浏览器。** 地址栏、前进后退、原生 webview / iframe、本地文件页。`OpenAI.Codex_26.1007.9446.0` 的 `native-menu-locales/zh-CN.json` 经 rea 6.5.0 分析后，`json_top_level_keys`（`omitted_json_top_level_keys: 0`）含 `browserSidebar.*`、`codex.command.openBrowserTab`、`codex.command.focusBrowserAddressBar`、`codex.commandMenuTitle.reloadBrowserPage`、`codex.commandMenuTitle.hardReloadBrowserPage`。键名说明这版有浏览器侧栏命令；中文值没有进入 semantic_graph。浏览器组件 props 未分析，不按键名改交互，也不删工作台浏览器。
- **页面标注。** 键 `browserSidebar.contextMenu.commentWithCodex` 存在。标注模式和注释提交的组件状态未观察，功能保留。
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
| `agents/claude/runtime.rs` | 一个 `Shared` 和它的 stdin / stdout 循环。进程、目录和消息映射已经在别的文件 |
| `agents/claude/messages.rs` | 一条 Claude 转录到时间线事件的映射 |
| `agents/claude/usage.rs` | 一份用量账本。实时流和回合结束写的是同一份绝对快照 |
| `panel/diff/DiffView.tsx` → `files/ChangesSidebar.tsx` | 变更右列用的是打开文件同一套树、菜单和附加。把侧栏挪进 diff 仍然要引用这些文件控件 |
| `viewers/html.tsx` → `browser/BrowserView` | HTML 文件页就是这块浏览器主机。查看器注册要挂上它 |

`Workspace`、`RightPane`、`EmptyState`、`UpdateDialog`、命令菜单宿主、工作树按钮不再直接调用 `useWorkbench`。展示组件里还直接调用的，是 `PanelProvider`（规则允许的边界）和 `PlanChoicePreview`（这一轮不改 Plan）。

审计时如果上面某一条已经不再成立，删掉对应行，不要留过期借口。
