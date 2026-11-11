//! 安装探测、升级，以及不打开会话就能拿到的 Agent 资料。

use crate::features::agents;
use crate::models::*;

/// 本机已注册 CLI 的安装与更新状态。未安装的也会返回，供设置页展示。
#[tauri::command]
pub async fn list_agent_installations() -> Vec<AgentInstallation> {
    agents::list_installations().await
}

/// 按该 Agent 声明的官方渠道升级，并返回刷新后的安装状态。
#[tauri::command]
pub async fn update_agent(kind: AgentKind) -> Result<AgentInstallation, String> {
    agents::upgrade(kind).await.map_err(|err| err.to_string())
}

/// 当前 agent 的订阅额度。能力关闭时拒绝，界面不显示。
#[tauri::command]
pub async fn subscription_usage(kind: AgentKind) -> Result<SubscriptionUsage, String> {
    let adapter = agents::adapter_for(kind);
    if !adapter.capabilities().supports_subscription_usage {
        return Err("这个 Agent 没有订阅用量".into());
    }
    adapter
        .subscription_usage()
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn agent_profiles() -> Vec<AgentProfile> {
    AgentKind::all()
        .into_iter()
        .map(|kind| {
            let adapter = agents::adapter_for(kind);
            let mut profile = adapter.profile();
            profile.display_name = Some(adapter.display_name().to_string());
            profile.icon = adapter.icon_href().map(str::to_string);
            profile.icon_monochrome = adapter.icon_monochrome();
            profile
        })
        .collect()
}
