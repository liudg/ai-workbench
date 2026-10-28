# v2 功能清单（迁移第 3 步）

v1 的功能逐项标「沿用」「改进」「去掉」。改进写出处，去掉写理由。2026-10-26 用户确认后开始实施。

- **沿用**：功能和交互不变，数据来源换成 daemon。
- **改进**：在 v1 的基础上按参考项目改。标了「路线图 N」的，按 [reference-projects-roadmap.md](reference-projects-roadmap.md) 第 N 项的阶段做，第 3 步先沿用 v1。
- **v2 现状**（2026-10-27）：
  - **网页已验**：在网页预览里连真实 daemon（独立的数据目录）点过，结果对。
  - **已接上**：daemon 方法和界面都接上了，有测试或只看了代码，还没在界面上点过。
  - **桌面已验**：2026-10-27 在桌面版里（`pnpm tauri:dev`，真实数据目录）点过，结果对。当天 Codex 连不上它的服务器，需要模型回话的部分没验。
  - **桌面待验**：要用系统对话框、托盘、内置浏览器窗口这些原生界面，得在桌面版里手动点。
  - 2026-10-28 迁移第 4 步在网页预览里用真实 Claude Code 跑过：新会话、选模型、审批、计划模式和退出计划、排队、引导、中断、工作树、目标、差异面板、订阅额度、关页面后续上、daemon 重启后 resume。

## 1. 项目
| 功能 | v1 位置 | 标记 | 说明 | v2 现状 |
|---|---|---|---|---|
| 新建项目：选存放位置、填名称、可选初始化 git | `sidebar/projects/NewProjectDialog.tsx`，`create_project` | 沿用 | `projects.create` | 已接上（daemon 有测试） |
| 导入现有文件夹 | 同上，`import_project` | 沿用 | 点「添加项目」打开 v1 的对话框，不再直接弹出系统选择框 | 网页已验 |
| 项目默认 Agent | `useNewProjectForm.ts` 的 `defaultAgent` | 去掉 | 改成在每个会话里选。新会话默认用上次选的 Agent 和这个 Agent 上次选的模型（t3code `apps/web/src/composerDraftStore.ts` 的 `stickyActiveProvider`、`stickyModelSelectionByProvider`） | 已去掉（迁移 3 删了这一列） |
| 编辑项目：名称、多个源文件夹 | `EditProjectDialog.tsx`，`update_project` | 沿用 | `projects.update` | 网页已验（改名） |
| 置顶项目 | `project-menu.ts`、`project-sections.ts` | 沿用 | 存进数据库 | 网页已验 |
| 在资源管理器中打开 | `project-menu.ts`，`open_project_folder` | 沿用 | 壳新增 `reveal_folder` | 桌面已验（命令没报错；窗口要人看一眼） |
| 移除项目 | `project-menu.ts`，`remove_project` | 改进 | 项目下的会话（含侧栏不显示的已归档会话）一起删，先停掉它们的 Agent；磁盘目录和工作树不动。再点一次确认，确认文案写明删几个会话（t3code `apps/web/src/components/LegacySidebar.tsx` 的 `handleRemoveProject`，`force: true`） | 已接上（daemon 有测试） |
| 分支显示、切换、新建 | `chat/composer/GitBranchControl.tsx`，`project_branch` / `project_checkout_branch` / `project_create_branch` / `project_git_branches` | 沿用 | `git.*`，按会话或项目 | 桌面已验（显示）；切换、新建已接上 |
| 提交、推送、开 PR 的按钮 | 无 | 改进（路线图 8） | v1 没有。按仓库状态给出一个主操作，和分支控件并存（t3code `apps/web/src/components/GitActionsControl.logic.ts`） | — |

## 2. 侧栏和会话列表
| 功能 | v1 位置 | 标记 | 说明 | v2 现状 |
|---|---|---|---|---|
| 「项目 → 会话」列表，按时间排序，虚拟滚动 | `sidebar/sessions/*` | 沿用 | 一个任务一行，显示任务现在用的会话 | 桌面已验 |
| 会话状态点 | `SessionStatusDot.tsx`、`session-status.ts` | 改进（迁移第 6 步） | 换成状态药丸，颜色只用来提示「需要你看」（t3code `apps/web/src/components/Sidebar.logic.ts`）：待批准、待回答、没看过的失败和完成；运行中是灰色呼吸点。未读由 daemon 记，替掉 v1 存在本地的「未读完成」 | 网页已验（2026-10-28，真实 Claude） |
| 「只读」标记 | `SessionRow.tsx` | 去掉 | v1 读 CLI 历史文件时用来标被别的进程占着的会话；v2 由 daemon 独占会话，没有这个来源 | — |
| 新建会话按钮和 Agent 菜单 | `NewSessionButton.tsx`、`lib/agents` 的 `newSessionMenu` | 改进 | 按钮只负责开新会话；Agent 和模型放到作曲栏里选（t3code `apps/web/src/components/chat/ModelPickerContent.tsx`） | 桌面已验 |
| 独立聊天（不属于任何项目）和设置里的「无项目任务文件夹」 | `sidebar/chats/ChatGroup.tsx`，`task_folder` / `set_task_folder` | 沿用 | 2026-10-26 用户确认保留。做法见 architecture-v2.md「领域模型」 | 网页已验（建目录、建任务）；当天 Codex 连不上服务器，没跑完一轮对话 |
| 重命名 | `session-menu.ts`，`rename_session` | 改进 | v1 要看 Agent 支不支持；v2 记在数据库里，所有 Agent 都能改（architecture-v2.md「Agent 驱动接口」） | 桌面已验 |
| 置顶 | `session-menu.ts`、`use-pinned-session-ids.ts` | 沿用 | 改成存在数据库里 | 桌面已验 |
| 归档 / 取消归档 | `session-menu.ts`，`set_session_archived` | 改进 | 同重命名 | 桌面已验（取消归档从命令菜单） |
| 删除，以及删除前预览工作树 | `DeleteSessionDialog.tsx`，`delete_session` / `session_worktree_delete_preview` | 改进 | 同重命名；保留 v1 的工作树预览，确认后连工作树和 `aiwb/` 分支一起删 | 桌面已验（主目录会话）；工作树的删除预览 daemon 有测试 |
| 侧栏开关 Ctrl+B，收起后悬停贴边展开 | `use-sidebar.ts`、`SidebarPeek.tsx` | 沿用 | | 已接上（渲染测试） |
| CLI 里的历史会话自动出现在侧栏 | `SessionManager` 合并各 CLI 目录 | 去掉 | 2026-10-26 用户确认改成手动导入（迁移第 4 步）：项目菜单「导入 CLI 会话」，见 architecture-v2.md 第 4 步 | 网页已验（2026-10-28，Codex 和 Claude 各导入一条并续聊） |
| 左下角菜单：检查更新、设置、命令菜单 | `sidebar/account/AccountMenu.tsx` | 沿用 | | 网页已验（设置） |

## 3. 作曲栏
| 功能 | v1 位置 | 标记 | 说明 | v2 现状 |
|---|---|---|---|---|
| 输入、Enter 发送、输入法保护 | `ComposerInput.tsx`、`composer-keys.ts` | 沿用 | 桌面已验 |
| 选 Agent | 无（v1 在新建会话按钮里选） | 改进 | 新会话在作曲栏上方选；会话中途在模型菜单的 Agent 竖栏换到别的 Agent，前文交给新 Agent（迁移第 5 步）。两边都声明 `supports_context_handoff` 且回合不在进行中才能换，否则锁定（t3code `apps/web/src/components/ChatView.tsx` 的 `modelPickerLockedProvider`、`ModelPickerSidebar.tsx`） | 桌面已验（显示和选择）；网页已验中途换（2026-10-28，Codex → Claude → Codex） |
| 模型、强度、速度档 | `ModelMenu.tsx`、`model-picker.ts`，`set_session_tuning` / `set_session_service_tier` | 沿用 | 新会话用这个 Agent 上次拿到的模型目录（daemon 记下）；一次都没拿到过时提示用默认模型 | 网页已验（显示） |
| 权限：预设、网络、可写目录、profile | `AccessMenu.tsx`、`access.ts`，`set_session_access` | 沿用 | 新会话默认用这个 Agent 上次的选择或它的默认档 | 桌面已验（显示） |
| 主目录或新工作树 | `WorktreeChoice.tsx`、`worktree-option.ts` | 沿用 | 工作树由任务层建，不再看 Agent 能力，有提交就能选 | 桌面已验（开关）；在网络共享上的仓库里建工作树会被 git 以 safe.directory 拒绝，错误原样显示、不留残留 |
| 空会话上方选项目 | `WorkContextPicker.tsx`、`useComposerWorkContext.ts` | 沿用 | 只在新会话上，换项目时草稿跟过去 | 网页已验（显示） |
| 附件：文件、图片、粘贴图片、从系统拖入文件 | `AttachMenu.tsx`、`Attachments.tsx`、`media.ts`、`useFileDrop.ts`、`lib/native/file-drop.ts` | 改 | 拖入走应用壳的拖放事件，拿真实路径，图片和文件都收（拖到作曲栏松手才收，orca `NativeChatPaneFileDropSurface.tsx`）；点缩略图放大看，多张左右切换（t3code `ExpandedImagePreview.tsx`）；点文件名在右侧「打开文件」里预览（t3code `ComposerFilePreviewDialog`，换成本项目已有的文件预览） | 桌面已验（模拟拖放事件、点开图片和文件）；真实鼠标拖放待验 |
| `@` 提及文件 | `MentionMenu.tsx`、`mentions.ts` | 沿用 | 新会话按项目目录找 | 已接上 |
| `$` 技能 | `SkillMenu.tsx`、`skills.ts` | 沿用 | | 已接上 |
| `/` 斜杠命令 | `SlashMenu.tsx` | 沿用 | | 已接上 |
| 计划模式、协作模式 | `PlanModeIndicator.tsx`、`ModeChip.tsx`、`collaboration-mode.ts`，`set_collaboration_mode` | 沿用 | 新会话先记在草稿里，建任务时带上 | 已接上 |
| 目标：设置、暂停、清除、状态条 | `GoalStatusBar.tsx`、`goal.ts`，`set_thread_goal` 等 | 沿用 | `sessions.setGoal` 等；新会话的目标随建任务一起设 | 已接上 |
| 排队和 steer，跟进模式切换，Ctrl+Enter 逐条引导 | `QueueStrip.tsx`、`follow-up-queue-mode.ts` | 沿用 | 跟进模式记在会话选项里 | 已接上 |
| 代码审查菜单 | `ReviewMenu.tsx`，`review_targets` / `start_review` | 沿用 | | 已接上 |
| 引用文本片段（来自聊天记录、文件预览的选区） | `TextSnippets.tsx`、`ChatSelectionMenu.tsx` | 沿用 | | 已接上 |
| 草稿 | `store/draft-session.ts`、`draft-storage.ts` | 改进 | 文字、附件、片段、新会话的选项都存进 daemon，切会话、重启都不丢（architecture-v2.md `draft` 表；t3code `apps/web/src/composerDraftStore.ts`） | 已接上 |
| 历史 prompt、暂存、长文本自动转附件 | 无 | 改进（路线图 14） | v1 没有 | — |

## 4. 聊天记录
| 功能 | v1 位置 | 标记 | 说明 | v2 现状 |
|---|---|---|---|---|
| 时间线、回合折叠、虚拟化、跟随滚动 | `chat/timeline/*` | 沿用 | | 网页已验 |
| 回答、思考、工具调用、活动分组、状态提示 | `chat/events/*` | 沿用 | 网页已验（回答）；桌面已验（错误） |
| 审批卡、问题卡、计划选择、elicitation | `ApprovalCard.tsx`、`QuestionCard.tsx`、`PlanChoiceSurface.tsx`、`ElicitationCard.tsx` | 沿用 | | 已接上 |
| 变更卡、网页卡、图片 | `chat/cards/*`、`EventImages.tsx` | 沿用 | | 已接上 |
| 会话内查找 Ctrl+F | `chat/find/*` | 沿用 | | 已接上 |
| 加载更早的记录 | `load_older_history` | 改进 | 时间线整份从数据库读，不再翻 CLI 的历史文件；分页等长会话再做 | 第 3 步不需要 |
| 分叉会话 | 命令菜单「分叉聊天」，`fork_session` | 改进（迁移第 5 步） | 命令菜单「分叉聊天」和「分叉到 <Agent>」：同一个 Agent 用原生分叉，换 Agent 时新会话第一条消息带上全部前文（t3code `apps/server/src/orchestration-v2/Orchestrator.ts` 的 `thread.fork`：同 provider 走 native_fork，否则 portable_context） | 网页已验（2026-10-28，分叉到 Claude） |
| 用量：会话 token、订阅额度 | `SessionUsageMeter.tsx`、`SubscriptionUsageMeter.tsx` | 沿用 | | 网页已验（token） |
| 「下一个需要处理的会话」 | `attention/next-session.ts` | 改进（迁移第 6 步） | 换成注意力队列（路线图 1）：命令菜单「下一个需要处理的聊天」按待批准 > 待回答 > 失败 > 完成、同级等得久的在前，到头绕回；没有等着你的会话时不出这一项 | 网页已验 |

## 5. 右侧面板
| 功能 | v1 位置 | 标记 | 说明 | v2 现状 |
|---|---|---|---|---|
| 面板开关和右侧栏按钮（没有会话时也能打开） | `panel/core/SessionSplit.tsx`、`ClosedChrome.tsx` | 沿用 | 新会话按项目主目录读（`files.*` 支持项目范围） | 已接上 |
| 差异：范围（上一轮、未提交、未暂存、已暂存；未提交和未暂存含未跟踪文件）、分栏或合并、折叠、跳转文件、选项菜单 | `panel/diff/*` | 沿用 | 桌面已验（打开） |
| 复制 `git apply` 命令 | `panel/diff/git-apply.ts` | 沿用 | | 已接上 |
| 逐行评论后批量发回、hunk 级暂存和还原 | 无 | 改进（路线图 7、8） | v1 没有 | — |
| 文件树、打开的文件标签、面包屑、右键「添加到聊天」 | `panel/files/*` | 沿用 | 桌面已验（打开文件、Markdown 预览） |
| 文件名和正文搜索 Ctrl+Shift+F，跳转文件 Ctrl+P | `FileSearchDialog.tsx`、`useQuickOpen.ts` | 沿用 | Ctrl+P 走 `files.quickOpen` | 桌面已验（Ctrl+P） |
| 预览：源码、Markdown（预览和源码切换）、图片、HTML、文档 | `panel/viewers/*` | 沿用 | | 网页已验（源码） |
| 用默认应用或指定应用打开 | `OpenWithMenu.tsx`、`open-with.ts` | 沿用 | | 桌面待验 |
| 内置浏览器：标签页、新标签页、页面批注 | `panel/browser/*` | 沿用 | | 桌面待验 |
| 终端 | 无 | 改进（路线图 10） | v1 没有 | — |

## 6. 命令菜单和快捷键
| 功能 | v1 位置 | 标记 | 说明 | v2 现状 |
|---|---|---|---|---|
| 命令菜单 Ctrl+K：新聊天、新独立聊天、打开文件夹、设置、搜索聊天、会话内查找、搜索文件、归档、重命名、置顶、删除、面板开关、侧栏开关、跳转文件 | `command-menu/*` | 沿用 | 动作走和界面同一组 daemon 方法；挂在会话视图的面板里。「下一个待处理」「分叉」见第 4 节 | 桌面已验 |
| 快捷键：Ctrl+Shift+O 新聊天、Ctrl+Shift+Delete 删除、Ctrl+Shift+B / Ctrl+Shift+F 面板 | `command-menu/copy.ts`、`shared/strings/desktop-zh.ts` | 沿用 | | 已接上；归档快捷键已移除 |
| 跳转面板 Ctrl+J | 无 | 改进（路线图 5） | orca `src/renderer/src/components/WorktreeJumpPalette.tsx` | — |
| 自定义快捷键 | 无 | 改进（路线图 16） | t3code `packages/shared/src/keybindings.ts` | — |

## 7. 设置、更新、托盘
| 功能 | v1 位置 | 标记 | 说明 | v2 现状 |
|---|---|---|---|---|
| 本地 Agent：检测安装、版本、升级 | `settings/SettingsView.tsx`、`agent-card.ts`，`list_agent_installations` / `update_agent` | 沿用 | `agents.installations` / `agents.upgrade` | 桌面已验（检测） |
| MCP：列表、添加、删除、启停、登录登出、看工具 | `settings/mcp/*`，`mcp_*` | 沿用 | `mcp.*` | 桌面已验（列表） |
| 无项目任务文件夹 | `useTaskFolder.ts` | 沿用 | 记在数据库，首次启动搬旧版 `task-folder.json` | 桌面已验（显示）；更改要用系统对话框，桌面待验 |
| 应用更新 | `updates/UpdateDialog.tsx`，`tauri-plugin-updater` | 沿用 | 网页预览里显示没有更新源，不再假装已是最新 | 桌面待验 |
| 托盘：显示窗口、退出 | `src-tauri/src/tray.rs` | 改进 | 退出时还有会话在运行或等输入就二次确认（architecture-v2.md「进程结构」） | 桌面待验 |
| 系统通知、任务栏角标 | 无 | 改进（迁移第 6 步） | 应用壳订阅 `tasks`，会话变成未读时发系统通知（要你处理 / 完成 / 失败），窗口没焦点时闪任务栏；等着你的会话数画进任务栏覆盖图标（Windows）或角标，托盘提示也带上。正在看的会话不提醒（orca `src/renderer/src/attention/agent-attention-policy.ts`、`src/main/notifications/notification-delivery-service.ts`）。还没有通知开关和声音 | 桌面待验（有单元测试） |

## 8. 开发用
| 功能 | v1 位置 | 标记 | 说明 | v2 现状 |
|---|---|---|---|---|
| 网页预览里的界面样例页（`?preview=diff` 等） | `app/App.tsx`、`app/preview/*` | 沿用 | 17 个；v1 的注意力样例不再要，侧栏样例里带上各种药丸。侧栏、工作上下文样例用固定数据不连后台；文件类样例连 daemon 读真实目录 | 网页已验（侧栏、工作上下文） |
| 网页预览连后端 | `src-tauri/src/dev_bridge.rs` | 去掉 | 网页预览直接连 daemon（architecture-v2.md「进程结构」）；`dev_bridge` 第 8 步已删 | 有 |
