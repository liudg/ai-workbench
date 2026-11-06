# 侧边聊天

每次主动新建会创建独立标签，以编号区分。选中文字或排队消息转到侧边聊天时，复用最近激活且仍开着的聊天；没有时首次创建。内容追加到输入框，不覆盖已有草稿，不自动发送。排队消息成功从主队列移除后，文字和图片一起放进草稿。

任务通过 `sides` 列表提供全部侧边会话。创建接口每次创建新会话，关闭和标签保活均按会话 ID 操作；关闭一个不影响其他聊天。标签创建尚未完成时关闭，创建请求返回后立即清理该会话。切换 Agent、停止任务和 daemon 重启仍清理该任务的临时聊天。

分叉、继承上下文和临时会话的原有实现参考 Codex `codex-rs/tui/src/app/side.rs`，适配器实现位于 `crates/aiwb-agents/src/codex/side.rs` 和 `crates/aiwb-agents/src/claude/command.rs`。工作台的多标签交互由本项目定义，不沿用终端界面的一次一个限制和主线程状态栏。

原生验证入口：`cargo test -p aiwb-daemon --test handoff_cli multiple_temporary_chats_with_native_clis -- --ignored --nocapture`。该测试需要已登录的本地 CLI，会创建隔离测试目录并调用模型；验证两个临时聊天同时继承上下文及单独关闭。
