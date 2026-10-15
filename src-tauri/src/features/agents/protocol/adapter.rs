//! Agent 适配器：一种 CLI 对应一个实现。会话列表属于 SessionManager。

use std::sync::Arc;

use async_trait::async_trait;

use crate::features::agents::directory::DirectoryEntry;
use crate::features::agents::install::{self, CliRelease};
use crate::models::{
    AgentCapabilities, AgentInstallation, AgentKind, AgentProfile, PermissionMenu,
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

    /// 侧栏图标。没有资源时返回 None，调用方不要补一张别的 Agent 的图。
    fn icon_href(&self) -> Option<&'static str> {
        None
    }

    fn capabilities(&self) -> AgentCapabilities;

    /// 斜杠命令等不需要已打开会话就能给出的目录。模型/技能仍走 `AgentSession::catalog`。
    fn profile(&self) -> AgentProfile {
        AgentProfile {
            kind: self.kind(),
            capabilities: self.capabilities(),
            commands: Vec::new(),
            default_access: None,
            display_name: None,
            icon: None,
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

    /// 探测安装版本，并对照官方来源看有没有更新。
    async fn installation(&self) -> AgentInstallation {
        let mut item = match self.cli_release() {
            Some(release) => {
                install::inspect_release(self.kind(), self.display_name(), &release).await
            }
            None => AgentInstallation::absent(self.kind(), self.display_name()),
        };
        item.session_linked = self.session_linked();
        item
    }

    /// 按适配器声明的官方渠道升级，然后重新探测。
    async fn upgrade(&self) -> Result<AgentInstallation, AgentError> {
        let Some(release) = self.cli_release() else {
            return Err(AgentError::Runtime(format!(
                "{} 没有官方更新入口",
                self.display_name()
            )));
        };
        install::upgrade_release(self.kind(), self.display_name(), &release)
            .await
            .map(|mut item| {
                item.session_linked = self.session_linked();
                item
            })
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

    /// 分叉聊天。历史由适配器复制。
    async fn fork_thread(&self, _native_id: &str) -> Result<DirectoryEntry, AgentError> {
        Err(AgentError::Runtime(format!(
            "{} 不支持分叉聊天",
            self.display_name()
        )))
    }

    /// 重命名聊天。
    async fn rename_thread(&self, _native_id: &str, _name: &str) -> Result<(), AgentError> {
        Err(AgentError::Runtime(format!(
            "{} 不支持重命名聊天",
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

    /// 归档或取消归档。只有声明了 `supports_archive` 的适配器覆盖它。
    async fn set_archived(&self, _native_id: &str, _archived: bool) -> Result<(), AgentError> {
        Err(AgentError::Runtime(format!(
            "{} 不支持归档",
            self.display_name()
        )))
    }
}
