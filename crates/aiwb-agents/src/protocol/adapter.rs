//! Agent 适配器：一种 CLI 对应一个实现。会话列表在 daemon 的数据库里。

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;

use crate::directory::{DirectoryEntry, DirectoryPage};
use crate::install::{self, CliRelease};
use crate::mcp::McpDriver;
use aiwb_core::models::{
    AgentCapabilities, AgentInstallation, AgentKind, AgentProfile, PermissionMenu,
    SessionEventBody, SubscriptionUsage,
};

use super::context::SessionContext;
use super::error::AgentError;
use super::session::{AgentSession, EventSink};

/// 一种 Agent CLI。负责按项目环境启动 [`AgentSession`]，不持有会话列表。
#[async_trait]
pub trait AgentAdapter: Send + Sync {
    fn kind(&self) -> AgentKind;

    fn display_name(&self) -> &'static str {
        self.kind().display_name()
    }

    /// 实例主键（如 `codex`、`codex-work`）。
    fn instance_id(&self) -> Option<&str> {
        None
    }

    /// 实例自定义显示名（未自定义时返回 None，退回 `display_name()`）。
    fn custom_display_name(&self) -> Option<&str> {
        None
    }

    /// 实例强调色（如 `#6366f1`）。
    fn accent_color(&self) -> Option<&str> {
        None
    }

    /// 实例单独指定的二进制路径（未覆盖时返回 None，走默认探测）。
    fn custom_binary_path(&self) -> Option<&std::path::Path> {
        None
    }

    /// 侧栏图标。没有资源时返回 None，调用方不要补一张别的 Agent 的图。
    fn icon_href(&self) -> Option<&'static str> {
        None
    }

    /// 侧栏图标是否为单色剪影（浅色主题下跟随前景加深）。多色品牌图标保持 false。
    fn monochrome_icon(&self) -> bool {
        false
    }

    fn capabilities(&self) -> AgentCapabilities;

    /// 当前账号的订阅额度窗口。只有 `supports_subscription_usage` 的适配器覆盖它。
    /// 不打开用户正在用的会话。没有窗口时返回空列表，界面不画。
    async fn subscription_usage(&self) -> Result<SubscriptionUsage, AgentError> {
        Err(AgentError::Runtime(format!(
            "{} 不支持订阅用量",
            self.display_name()
        )))
    }

    /// 不启动 CLI 即可给出的静态斜杠命令表。
    fn commands(&self) -> Vec<aiwb_core::models::SlashCommand> {
        Vec::new()
    }

    /// 新建会话时的默认权限档（如 `"full"`）。未声明时返回 None。
    fn default_access(&self) -> Option<&'static str> {
        None
    }

    /// 斜杠命令等不需要已打开会话就能给出的目录。模型/技能仍走 `AgentSession::catalog`。
    fn profile(&self) -> AgentProfile {
        AgentProfile {
            kind: self.kind(),
            instance_id: self.instance_id().map(str::to_string),
            capabilities: self.capabilities(),
            commands: self.commands(),
            default_access: self.default_access().map(str::to_string),
            display_name: self.custom_display_name().map(str::to_string),
            accent_color: self.accent_color().map(str::to_string),
            icon: self.icon_href().map(str::to_string),
            monochrome_icon: self.monochrome_icon(),
        }
    }

    /// 本机 CLI 的发布信息。没有的适配器不出现在设置页和新建会话里。
    fn cli_release(&self) -> Option<CliRelease> {
        None
    }

    /// 检测本机 CLI 是否安装。
    async fn detect(&self) -> Result<(), AgentError>;

    /// 会话协议是否已接入。只有接入的适配器覆盖 `start_session`。
    fn session_linked(&self) -> bool {
        false
    }

    /// 会读 `SessionContext::workbench_mcp`，把工作台 MCP 注入 Agent。
    fn takes_workbench_mcp(&self) -> bool {
        false
    }

    /// 探测安装版本。`check_updates` 时再对照官方来源看有没有更新，要走网络。
    async fn installation(&self, check_updates: bool) -> AgentInstallation {
        let label = self.custom_display_name().unwrap_or_else(|| self.display_name());
        let mut item = if let Some(custom_path) = self.custom_binary_path() {
            install::inspect_custom_binary(self.kind(), label, custom_path).await
        } else {
            match self.cli_release() {
                Some(release) => {
                    install::inspect_release(self.kind(), label, &release, check_updates).await
                }
                None => AgentInstallation::absent(self.kind(), label),
            }
        };
        item.instance_id = self.instance_id().map(str::to_string);
        item.session_linked = self.session_linked();
        item
    }

    /// 同一份安装（包括命令别名）共用更新状态，不运行 CLI。
    fn upgrade_key(&self) -> Option<PathBuf> {
        let path = install::locate_release(&self.cli_release()?)?;
        let path = std::fs::canonicalize(&path).unwrap_or(path);
        if cfg!(windows) {
            Some(PathBuf::from(path.to_string_lossy().to_lowercase()))
        } else {
            Some(path)
        }
    }

    /// 执行官方升级命令，直接返回退出码，不在结束后启动 CLI 探测。
    async fn upgrade(&self, output: crate::UpgradeOutput) -> Result<Option<i32>, AgentError> {
        let Some(release) = self.cli_release() else {
            return Err(AgentError::Runtime(format!(
                "{} 没有官方更新入口",
                self.display_name()
            )));
        };
        install::upgrade_release(self.display_name(), &release, output)
            .await
            .map_err(AgentError::Runtime)
    }

    /// 在指定项目目录中启动一个新会话。未接入的适配器直接拒绝。
    async fn start_session(
        &self,
        _ctx: SessionContext,
        _events: EventSink,
    ) -> Result<Arc<dyn AgentSession>, AgentError> {
        Err(AgentError::NotLinked(self.kind().display_name()))
    }

    /// 在 CLI 里以 `cwd` 为工作目录开过、可以导入工作台的会话，一页最多 `limit` 条。
    /// 只有接入了会话协议的适配器覆盖它。
    async fn import_page(
        &self,
        _cwd: &str,
        _cursor: Option<&str>,
        _limit: usize,
    ) -> Result<DirectoryPage, AgentError> {
        Err(AgentError::NotLinked(self.kind().display_name()))
    }

    /// 导入一条 CLI 里的历史会话：按时间顺序给出整段时间线，不改原生会话。
    /// 默认用 resume 接上，把首屏和更早的页都读完再关掉；能直接读转录的适配器自己覆盖。
    async fn import_history(
        &self,
        native_id: &str,
        cwd: &str,
    ) -> Result<Vec<SessionEventBody>, AgentError> {
        let ctx = SessionContext {
            project_path: cwd.to_string(),
            access_mode: None,
            resume_native_id: Some(native_id.to_string()),
            workbench_mcp: None,
            options: serde_json::json!({ "persist": true }),
        };
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let handle = self.start_session(ctx, tx).await?;
        let mut latest = Vec::new();
        while let Ok(body) = rx.try_recv() {
            latest.push(body);
        }
        let mut pages = Vec::new();
        let read = async {
            loop {
                let (page, exhausted) = handle.load_older_history().await?;
                let empty = page.is_empty();
                pages.push(page);
                if exhausted || empty {
                    return Ok::<_, AgentError>(());
                }
            }
        }
        .await;
        let _ = handle.stop().await;
        read?;
        Ok(pages.into_iter().rev().flatten().chain(latest).collect())
    }

    /// 分叉聊天。历史由适配器复制。`cwd` 不为空时分叉出来的线程在那个目录里接着跑。
    async fn fork_thread(&self, _native_id: &str, _cwd: Option<&str>) -> Result<DirectoryEntry, AgentError> {
        Err(AgentError::Runtime(format!(
            "{} 不支持分叉聊天",
            self.display_name()
        )))
    }

    /// 永久删除聊天。这不是删除工作区文件。
    async fn delete_thread(&self, _native_id: &str) -> Result<(), AgentError> {
        Err(AgentError::Runtime(format!(
            "{} 不支持永久删除",
            self.display_name()
        )))
    }

    /// 还没有会话时的权限菜单。不启动 CLI。
    fn draft_permission_menu(&self) -> PermissionMenu {
        PermissionMenu::unsupported()
    }

    /// 首条消息没有发出去时撤掉刚建的线程。默认走删除；不支持删除的适配器自己清掉现场。
    async fn discard_unsent_thread(&self, native_id: &str) -> Result<(), AgentError> {
        self.delete_thread(native_id).await
    }

    /// 这个 Agent 自己的 MCP 命令。没在本机 CLI 上验证过的返回 None。
    fn mcp(&self) -> Option<Arc<dyn McpDriver>> {
        None
    }

    /// 独立于主会话的无痕单轮轻量文本生成（标题、分支名、Commit 说明）。
    async fn generate_text(
        &self,
        _prompt: &str,
        _model: Option<&str>,
        _cwd: Option<&std::path::Path>,
    ) -> Result<String, AgentError> {
        Err(AgentError::Runtime(format!(
            "{} 不支持轻量文本生成",
            self.display_name()
        )))
    }

    /// 将原生会话回退到第 `kept_turns` 轮之后（即丢弃 `target_turn_id` 及之后的全部回合）。
    /// `delete_old` 为 `false` 时（例如存在分叉会话仍共享旧 `native_id`）保留旧原生会话不删除。
    /// 返回 `Ok(Some(new_native_id))` 表示原生会话已生成截断后的新 ID；
    /// 返回 `Ok(None)` 表示旧原生会话不再沿用，下一次发送通过前文交接（ContextHandoff）无缝续接。
    async fn rewind_thread(
        &self,
        _native_id: &str,
        _cwd: &str,
        _target_turn_id: Option<&str>,
        _kept_turns: usize,
        _delete_old: bool,
    ) -> Result<Option<String>, AgentError> {
        Err(AgentError::Runtime(format!(
            "{} 不支持会话回退",
            self.display_name()
        )))
    }
}
