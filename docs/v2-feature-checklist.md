# v2 功能清单（迁移第 3 步）

v1 的功能逐项标「沿用」「改进」「去掉」。改进写出处，去掉写理由。用户确认后再动手。

- **沿用**：功能和交互不变，数据来源换成 daemon。
- **改进**：在 v1 的基础上按参考项目改。标了「路线图 N」的，按 [reference-projects-roadmap.md](reference-projects-roadmap.md) 第 N 项的阶段做，第 3 步先沿用 v1。
- **v2 现状**：有 = daemon 方法和界面都接上了；部分 = 只有一部分；缺 = 还没有。只看了代码，没在真实应用里核对。

## 1. 项目
| 功能 | v1 位置 | 标记 | 说明 | v2 现状 |
|---|---|---|---|---|
| 新建项目：选存放位置、填名称、可选初始化 git | `sidebar/projects/NewProjectDialog.tsx`，`create_project` | 沿用 | | 缺：daemon 没有新建文件夹和 git init |
| 导入现有文件夹 | 同上，`import_project` | 沿用 | 点「添加项目」打开 v1 的对话框，不再直接弹出系统选择框 | 部分：`projects.add` 有，对话框没接 |
| 项目默认 Agent | `useNewProjectForm.ts` 的 `defaultAgent` | 去掉 | 改成在每个会话里选。新会话默认用上次选的 Agent 和这个 Agent 上次选的模型（t3code `apps/web/src/composerDraftStore.ts` 的 `stickyActiveProvider`、`stickyModelSelectionByProvider`） | v2 仍在用 |
| 编辑项目：名称、多个源文件夹 | `EditProjectDialog.tsx`，`update_project` | 沿用 | | 缺 |
| 置顶项目 | `project-menu.ts`、`project-sections.ts` | 沿用 | | 缺 |
| 在资源管理器中打开 | `project-menu.ts`，`open_project_folder` | 沿用 | | 缺：壳里有 `open_path`，菜单没接 |
| 移除项目 | `project-menu.ts`，`remove_project` | 沿用 | | 有 |
| 分支显示、切换、新建 | `chat/composer/GitBranchControl.tsx`，`project_branch` / `project_checkout_branch` / `project_create_branch` / `project_git_branches` | 沿用 | | 部分：作曲栏有控件，daemon 没有分支方法 |
| 提交、推送、开 PR 的按钮 | 无 | 改进（路线图 8） | v1 没有。按仓库状态给出一个主操作，和分支控件并存（t3code `apps/web/src/components/GitActionsControl.logic.ts`） | — |

## 2. 侧栏和会话列表
| 功能 | v1 位置 | 标记 | 说明 | v2 现状 |
|---|---|---|---|---|
| 「项目 → 会话」列表，按时间排序，虚拟滚动 | `sidebar/sessions/*` | 沿用 | 侧栏显示会话，不显示任务 | 缺：v2 显示的是任务列表 |
| 会话状态点 | `SessionStatusDot.tsx`、`session-status.ts` | 改进（迁移第 6 步） | 换成状态药丸，颜色只用来提示「需要你看」（t3code `apps/web/src/components/Sidebar.logic.ts`） | 缺 |
| 新建会话按钮和 Agent 菜单 | `NewSessionButton.tsx`、`lib/agents` 的 `newSessionMenu` | 改进 | 按钮只负责开新会话；Agent 和模型放到作曲栏里选（t3code `apps/web/src/components/chat/ModelPickerContent.tsx`） | 部分：有新任务页，不能选 Agent |
| 独立聊天（不属于任何项目）和设置里的「无项目任务文件夹」 | `sidebar/chats/ChatGroup.tsx`，`task_folder` / `set_task_folder` | 沿用 | 2026-10-26 用户确认保留。daemon 支持不属于项目的会话，做法见 architecture-v2.md「领域模型」 | 缺：daemon 里的任务必须属于某个项目 |
| 重命名 | `session-menu.ts`，`rename_session` | 改进 | v1 要看 Agent 支不支持；v2 记在数据库里，所有 Agent 都能改（architecture-v2.md「Agent 驱动接口」） | 部分：有 `tasks.rename`，菜单没接 |
| 置顶 | `session-menu.ts`、`use-pinned-session-ids.ts` | 沿用 | 改成存在数据库里 | 缺 |
| 归档 / 取消归档 | `session-menu.ts`，`set_session_archived` | 改进 | 同重命名 | 部分：有 `tasks.archive`，菜单没接 |
| 删除，以及删除前预览工作树 | `DeleteSessionDialog.tsx`，`delete_session` / `session_worktree_delete_preview` | 改进 | 同重命名；保留 v1 的工作树预览 | 部分：用的是 `window.confirm`，没有预览 |
| 侧栏开关 Ctrl+B，收起后悬停贴边展开 | `use-sidebar.ts`、`SidebarPeek.tsx` | 沿用 | | 部分：有开关，没有悬停展开 |
| CLI 里的历史会话自动出现在侧栏 | `SessionManager` 合并各 CLI 目录 | 去掉 | 2026-10-26 用户确认改成手动导入（迁移第 4 步） | — |
| 左下角菜单：检查更新、设置、命令菜单 | `sidebar/account/AccountMenu.tsx` | 沿用 | | 缺 |

## 3. 作曲栏
| 功能 | v1 位置 | 标记 | 说明 | v2 现状 |
|---|---|---|---|---|
| 输入、Enter 发送、输入法保护 | `ComposerInput.tsx`、`composer-keys.ts` | 沿用 | | 有 |
| 选 Agent | 无（v1 在新建会话按钮里选） | 改进 | 每个会话都能选；中途换 Agent 在迁移第 5 步（t3code `apps/web/src/components/ChatView.tsx` 的 `modelPickerLockedProvider`） | 缺 |
| 模型、强度、速度档 | `ModelMenu.tsx`、`model-picker.ts`，`set_session_tuning` / `set_session_service_tier` | 沿用 | 新会话也要有（v2 现在只有建好的任务才有） | 部分 |
| 权限：预设、网络、可写目录、profile | `AccessMenu.tsx`、`access.ts`，`set_session_access` | 沿用 | | 有 |
| 主目录或新工作树 | `WorktreeChoice.tsx`、`worktree-option.ts` | 沿用 | | 有 |
| 空会话上方选项目 | `WorkContextPicker.tsx`、`useComposerWorkContext.ts` | 沿用 | | 缺 |
| 附件：文件、图片、粘贴和拖入图片 | `AttachMenu.tsx`、`Attachments.tsx`、`media.ts` | 沿用 | | 有 |
| `@` 提及文件 | `MentionMenu.tsx`、`mentions.ts` | 沿用 | | 部分：未逐项核对 |
| `$` 技能 | `SkillMenu.tsx`、`skills.ts` | 沿用 | | 部分：未逐项核对 |
| `/` 斜杠命令 | `SlashMenu.tsx` | 沿用 | | 有 |
| 计划模式、协作模式 | `PlanModeIndicator.tsx`、`ModeChip.tsx`、`collaboration-mode.ts`，`set_collaboration_mode` | 沿用 | | 部分：选项里有 `collaborationMode`，未核对界面 |
| 目标：设置、暂停、清除、状态条 | `GoalStatusBar.tsx`、`goal.ts`，`set_thread_goal` 等 | 沿用 | | 缺：daemon 没有目标方法 |
| 排队和 steer，跟进模式切换 | `QueueStrip.tsx`、`follow-up-queue-mode.ts` | 沿用 | | 有 |
| 代码审查菜单 | `ReviewMenu.tsx`，`review_targets` / `start_review` | 沿用 | | 有 |
| 引用文本片段（来自聊天记录、文件预览的选区） | `TextSnippets.tsx`、`ChatSelectionMenu.tsx` | 沿用 | | 有 |
| 草稿 | `store/draft-session.ts`、`draft-storage.ts` | 改进 | 存进 daemon，切会话、重启都不丢（architecture-v2.md `draft` 表；t3code `apps/web/src/composerDraftStore.ts`） | 缺 |
| 历史 prompt、暂存、长文本自动转附件 | 无 | 改进（路线图 14） | v1 没有 | — |

## 4. 聊天记录
| 功能 | v1 位置 | 标记 | 说明 | v2 现状 |
|---|---|---|---|---|
| 时间线、回合折叠、虚拟化、跟随滚动 | `chat/timeline/*` | 沿用 | | 有 |
| 回答、思考、工具调用、活动分组、状态提示 | `chat/events/*` | 沿用 | | 有 |
| 审批卡、问题卡、计划选择、elicitation | `ApprovalCard.tsx`、`QuestionCard.tsx`、`PlanChoiceSurface.tsx`、`ElicitationCard.tsx` | 沿用 | | 有 |
| 变更卡、网页卡、图片 | `chat/cards/*`、`EventImages.tsx` | 沿用 | | 有 |
| 会话内查找 Ctrl+F | `chat/find/*` | 沿用 | | 未核对 |
| 加载更早的记录 | `load_older_history` | 改进 | 改成从数据库分页读，不再去翻 CLI 的历史文件 | 未核对 |
| 分叉会话 | 命令菜单「分叉聊天」，`fork_session` | 改进（迁移第 5 步） | v1 菜单里隐藏了，命令菜单里还留着。改成可以分叉到另一个 Agent（t3code `apps/server/src/orchestration-v2/ContextHandoffService.ts` 的 `prepareForkDelta`） | 缺 |
| 用量：会话 token、订阅额度 | `SessionUsageMeter.tsx`、`SubscriptionUsageMeter.tsx` | 沿用 | | 有 |
| 「下一个需要处理的会话」 | `attention/next-session.ts` | 改进（迁移第 6 步） | 换成注意力队列（路线图 1） | 缺 |

## 5. 右侧面板
| 功能 | v1 位置 | 标记 | 说明 | v2 现状 |
|---|---|---|---|---|
| 面板开关和右侧栏按钮（没有会话时也能打开） | `panel/core/SessionSplit.tsx`、`ClosedChrome.tsx` | 沿用 | | 部分：只有建好任务后才有 |
| 差异：范围（上一轮、未暂存、已暂存、未提交、分支）、分栏或合并、折叠、跳转文件、选项菜单 | `panel/diff/*` | 沿用 | | 有 |
| 复制 `git apply` 命令 | `panel/diff/git-apply.ts` | 沿用 | | 未核对 |
| 逐行评论后批量发回、hunk 级暂存和还原 | 无 | 改进（路线图 7、8） | v1 没有 | — |
| 文件树、打开的文件标签、面包屑、右键「添加到聊天」 | `panel/files/*` | 沿用 | | 有 |
| 文件名和正文搜索 Ctrl+Shift+F，跳转文件 Ctrl+P | `FileSearchDialog.tsx`、`useQuickOpen.ts` | 沿用 | | 部分：搜索有，Ctrl+P 在命令菜单里，命令菜单没接 |
| 预览：源码、Markdown（预览和源码切换）、图片、HTML、文档 | `panel/viewers/*` | 沿用 | | 有 |
| 用默认应用或指定应用打开 | `OpenWithMenu.tsx`、`open-with.ts` | 沿用 | | 有 |
| 内置浏览器：标签页、新标签页、页面批注 | `panel/browser/*` | 沿用 | | 有 |
| 终端 | 无 | 改进（路线图 10） | v1 没有 | — |

## 6. 命令菜单和快捷键
| 功能 | v1 位置 | 标记 | 说明 | v2 现状 |
|---|---|---|---|---|
| 命令菜单 Ctrl+K：新聊天、新独立聊天、打开文件夹、设置、搜索聊天、会话内查找、下一个待处理、搜索文件、归档、重命名、置顶、删除、分叉、面板开关、侧栏开关、跳转文件 | `command-menu/*` | 沿用 | 动作改走 daemon 方法，和界面用同一个方法 | 缺 |
| 快捷键：Ctrl+Shift+O 新聊天、Ctrl+Shift+A 归档、Ctrl+Shift+Delete 删除、Ctrl+Shift+B / Ctrl+Shift+F 面板 | `command-menu/copy.ts`、`shared/strings/desktop-zh.ts` | 沿用 | | 缺 |
| 跳转面板 Ctrl+J | 无 | 改进（路线图 5） | orca `src/renderer/src/components/WorktreeJumpPalette.tsx` | — |
| 自定义快捷键 | 无 | 改进（路线图 16） | t3code `packages/shared/src/keybindings.ts` | — |

## 7. 设置、更新、托盘
| 功能 | v1 位置 | 标记 | 说明 | v2 现状 |
|---|---|---|---|---|
| 本地 Agent：检测安装、版本、升级 | `workspace/settings/SettingsView.tsx`、`agent-card.ts`，`list_agent_installations` / `update_agent` | 沿用 | | 缺 |
| MCP：列表、添加、删除、启停、登录登出、看工具 | `workspace/settings/mcp/*`，`mcp_*` | 沿用 | | 缺 |
| 无项目任务文件夹 | `useTaskFolder.ts` | 沿用 | 跟独立聊天一起做 | 缺 |
| 应用更新 | `workspace/updates/UpdateDialog.tsx`，`tauri-plugin-updater` | 沿用 | | 缺：没有挂载 |
| 托盘：显示窗口、退出 | `src-tauri/src/tray.rs` | 改进 | 退出时有任务在跑就二次确认（architecture-v2.md「进程结构」） | 部分：退出会一起停掉 daemon，没有确认 |
| 系统通知、任务栏角标 | 无 | 改进（迁移第 6 步） | orca `src/renderer/src/attention/agent-attention-policy.ts` | — |

## 8. 开发用
| 功能 | v1 位置 | 标记 | 说明 | v2 现状 |
|---|---|---|---|---|
| 网页预览里的界面样例页（`?preview=diff` 等 18 个） | `app/App.tsx`、`app/preview/*` | 沿用 | 用来截图检查界面 | 缺：v2 入口去掉了 |
| 网页预览连后端 | `src-tauri/src/dev_bridge.rs` | 去掉 | 网页预览直接连 daemon（architecture-v2.md「进程结构」） | 有 |

