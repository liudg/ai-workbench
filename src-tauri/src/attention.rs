//! 应用壳作为 daemon 的一个客户端订阅任务列表：会话停下来要你看时发系统通知，
//! 等着你的会话数挂到任务栏角标和托盘提示上。窗口关着（藏在托盘里）也照样提醒。
//!
//! 未读由 daemon 按「有没有人正看着」记，所以正在看的会话跑完不会弹通知。
//! 照 orca `src/renderer/src/attention/agent-attention-policy.ts`（要你处理、已完成两类）
//! 和 `src/main/notifications/notification-delivery-service.ts`。

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use aiwb_core::attention::{AskKind, Attention, AttentionState};
use aiwb_core::rpc::{Push, TOPIC_TASKS};
use aiwb_core::task::TaskEntry;
use futures_util::{SinkExt, StreamExt};
use tauri::image::Image;
use tauri::{AppHandle, Manager, UserAttentionType};
use tauri_plugin_notification::NotificationExt;
use tokio_tungstenite::tungstenite::Message;

const RETRY: Duration = Duration::from_secs(2);
const TRAY_TOOLTIP: &str = "AI 工作台";

/// 应用启动时调用一次。连不上 daemon 就隔一会儿再试；daemon 由前端连接时拉起。
pub fn start(app: &AppHandle, data_dir: PathBuf) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut watcher = Watcher::default();
        loop {
            if let Some(info) = crate::daemon::current_info(&data_dir) {
                let url = format!("{}?token={}", info.ws_url(), info.token);
                // 连接断了重新订阅，拿到的第一份快照不当作变化。
                watcher.reset();
                let _ = follow(&app, &url, &mut watcher).await;
            }
            tokio::time::sleep(RETRY).await;
        }
    });
}

async fn follow(app: &AppHandle, url: &str, watcher: &mut Watcher) -> Result<(), String> {
    let (mut socket, _) = tokio_tungstenite::connect_async(url).await.map_err(|e| e.to_string())?;
    let subscribe = serde_json::json!({ "id": 1, "method": "subscribe", "params": { "topic": TOPIC_TASKS } });
    socket
        .send(Message::Text(subscribe.to_string()))
        .await
        .map_err(|e| e.to_string())?;
    while let Some(message) = socket.next().await {
        let Message::Text(text) = message.map_err(|e| e.to_string())? else {
            continue;
        };
        let Ok(push) = serde_json::from_str::<Push>(&text) else {
            continue;
        };
        if push.topic != TOPIC_TASKS {
            continue;
        }
        let Ok(entries) = serde_json::from_value::<Vec<TaskEntry>>(push.data) else {
            continue;
        };
        let update = watcher.update(&entries);
        deliver(app, &update);
    }
    Ok(())
}

/// 一次任务列表推送带来的提醒和角标数。
#[derive(Debug, Default, PartialEq)]
struct Update {
    notices: Vec<Notice>,
    waiting: usize,
}

#[derive(Debug, PartialEq)]
struct Notice {
    title: String,
    body: String,
}

/// 记着每个任务上次的未读，变成未读时提醒一次。
#[derive(Default)]
struct Watcher {
    unread: Option<HashMap<String, bool>>,
}

impl Watcher {
    fn reset(&mut self) {
        self.unread = None;
    }

    fn update(&mut self, entries: &[TaskEntry]) -> Update {
        let live: Vec<&TaskEntry> = entries.iter().filter(|entry| entry.task.archived_at.is_none()).collect();
        let notices = match &self.unread {
            None => Vec::new(),
            Some(before) => live
                .iter()
                .filter(|entry| entry.attention.unread && !before.get(&entry.task.id).copied().unwrap_or(false))
                .map(|entry| notice(entry))
                .collect(),
        };
        self.unread = Some(
            live.iter()
                .map(|entry| (entry.task.id.clone(), entry.attention.unread))
                .collect(),
        );
        Update {
            notices,
            waiting: live.iter().filter(|entry| waits_for_you(&entry.attention)).count(),
        }
    }
}

/// 和前端 `needsYou` 同一条规则。
fn waits_for_you(attention: &Attention) -> bool {
    match attention.state {
        AttentionState::NeedsInput => true,
        AttentionState::Done | AttentionState::Failed => attention.unread,
        AttentionState::Working | AttentionState::Idle => false,
    }
}

fn notice(entry: &TaskEntry) -> Notice {
    let attention = &entry.attention;
    let what = match (attention.state, attention.ask) {
        (AttentionState::NeedsInput, Some(AskKind::Approval)) => "等你批准",
        (AttentionState::NeedsInput, _) => "等你回答",
        (AttentionState::Failed, _) => "失败了",
        _ => "完成了",
    };
    let title = entry.task.title.trim();
    Notice {
        title: if title.is_empty() { "新会话".to_string() } else { title.to_string() },
        body: match &attention.preview {
            Some(preview) => format!("{what}：{preview}"),
            None => what.to_string(),
        },
    }
}

fn deliver(app: &AppHandle, update: &Update) {
    let window = app.get_webview_window("main");
    for notice in &update.notices {
        let _ = app
            .notification()
            .builder()
            .title(&notice.title)
            .body(&notice.body)
            .show();
    }
    if !update.notices.is_empty() {
        if let Some(window) = &window {
            if !window.is_focused().unwrap_or(false) {
                let _ = window.request_user_attention(Some(UserAttentionType::Informational));
            }
        }
    }
    if let Some(window) = &window {
        set_badge(window, update.waiting);
    }
    if let Some(tray) = app.tray_by_id(crate::tray::TRAY_ID) {
        let tooltip = match update.waiting {
            0 => TRAY_TOOLTIP.to_string(),
            n => format!("{TRAY_TOOLTIP} · {n} 个会话等着你"),
        };
        let _ = tray.set_tooltip(Some(tooltip));
    }
}

/// Windows 没有角标数字，用任务栏覆盖图标画一个；其他系统用自带的角标。
#[cfg(windows)]
fn set_badge(window: &tauri::WebviewWindow, count: usize) {
    let icon = (count > 0).then(|| Image::new_owned(badge_pixels(count), BADGE_SIZE, BADGE_SIZE));
    let _ = window.set_overlay_icon(icon);
}

#[cfg(not(windows))]
fn set_badge(window: &tauri::WebviewWindow, count: usize) {
    let _ = window.set_badge_count((count > 0).then_some(count as i64));
}

const BADGE_SIZE: u32 = 16;
const BADGE_FILL: [u8; 3] = [0xf0, 0xa0, 0x4a];

/// 3×5 的数字字模，每行低 3 位从左到右。
const DIGITS: [[u8; 5]; 10] = [
    [0b111, 0b101, 0b101, 0b101, 0b111],
    [0b010, 0b110, 0b010, 0b010, 0b111],
    [0b111, 0b001, 0b111, 0b100, 0b111],
    [0b111, 0b001, 0b111, 0b001, 0b111],
    [0b101, 0b101, 0b111, 0b001, 0b001],
    [0b111, 0b100, 0b111, 0b001, 0b111],
    [0b111, 0b100, 0b111, 0b101, 0b111],
    [0b111, 0b001, 0b010, 0b010, 0b010],
    [0b111, 0b101, 0b111, 0b101, 0b111],
    [0b111, 0b101, 0b111, 0b001, 0b111],
];
const PLUS: [u8; 5] = [0b000, 0b010, 0b111, 0b010, 0b000];

/// 16×16 RGBA：琥珀色圆点里写数字，1 到 9 放大两倍，再多写「9+」。
#[cfg_attr(not(windows), allow(dead_code))]
fn badge_pixels(count: usize) -> Vec<u8> {
    let size = BADGE_SIZE as i32;
    let mut pixels = vec![0u8; (size * size * 4) as usize];
    let center = (size as f32 - 1.0) / 2.0;
    let radius = size as f32 / 2.0;
    for y in 0..size {
        for x in 0..size {
            let distance = ((x as f32 - center).powi(2) + (y as f32 - center).powi(2)).sqrt();
            let alpha = (radius - distance).clamp(0.0, 1.0);
            if alpha > 0.0 {
                let at = ((y * size + x) * 4) as usize;
                pixels[at..at + 3].copy_from_slice(&BADGE_FILL);
                pixels[at + 3] = (alpha * 255.0) as u8;
            }
        }
    }
    let glyphs: Vec<&[u8; 5]> = if count < 10 {
        vec![&DIGITS[count]]
    } else {
        vec![&DIGITS[9], &PLUS]
    };
    let scale = if glyphs.len() == 1 { 2 } else { 1 };
    let width = glyphs.len() as i32 * 3 * scale + (glyphs.len() as i32 - 1) * scale;
    let left = (size - width) / 2;
    let top = (size - 5 * scale) / 2;
    for (index, glyph) in glyphs.iter().enumerate() {
        let origin = left + index as i32 * 4 * scale;
        for (row, bits) in glyph.iter().enumerate() {
            for column in 0..3 {
                if bits & (0b100 >> column) == 0 {
                    continue;
                }
                for dy in 0..scale {
                    for dx in 0..scale {
                        let x = origin + column * scale + dx;
                        let y = top + row as i32 * scale + dy;
                        let at = ((y * size + x) * 4) as usize;
                        pixels[at..at + 4].copy_from_slice(&[0x1a, 0x1a, 0x1a, 0xff]);
                    }
                }
            }
        }
    }
    pixels
}

#[cfg(test)]
mod tests {
    use super::*;
    use aiwb_core::models::{AgentKind, SessionStatus};
    use aiwb_core::task::{SessionOptions, Task, TaskSession, TaskWorkspace};

    fn entry(id: &str, state: AttentionState, unread: bool, archived: bool) -> TaskEntry {
        TaskEntry {
            task: Task {
                id: id.into(),
                project_id: None,
                title: format!("任务{id}"),
                workspace: TaskWorkspace::Root,
                pinned: false,
                archived_at: archived.then_some(1),
                created_at: 1,
                updated_at: 1,
                parent_task_id: None,
            },
            sessions: vec![TaskSession {
                id: format!("{id}-s"),
                task_id: id.into(),
                agent: AgentKind::CodexCli,
                native_id: None,
                status: SessionStatus::Completed,
                options: SessionOptions::default(),
                created_at: 1,
                updated_at: 1,
            }],
            attention: Attention {
                state,
                unread,
                ask: None,
                preview: Some("改好了".into()),
                updated_at: 1,
            },
            side: None,
            branch: None,
        }
    }

    #[test]
    fn first_snapshot_only_counts_and_new_unread_notifies_once() {
        let mut watcher = Watcher::default();
        let first = watcher.update(&[
            entry("a", AttentionState::Done, true, false),
            entry("b", AttentionState::Working, false, false),
            entry("c", AttentionState::NeedsInput, false, false),
            entry("old", AttentionState::Failed, true, true),
        ]);
        assert!(first.notices.is_empty());
        assert_eq!(first.waiting, 2);

        let next = watcher.update(&[
            entry("a", AttentionState::Done, true, false),
            entry("b", AttentionState::Done, true, false),
            entry("c", AttentionState::NeedsInput, false, false),
        ]);
        assert_eq!(
            next.notices,
            vec![Notice { title: "任务b".into(), body: "完成了：改好了".into() }]
        );
        assert_eq!(next.waiting, 3);

        // 同一个未读不再提醒；断线重连后的快照也不算变化。
        assert!(watcher.update(&[entry("b", AttentionState::Done, true, false)]).notices.is_empty());
        watcher.reset();
        assert!(watcher.update(&[entry("z", AttentionState::Failed, true, false)]).notices.is_empty());
    }

    #[test]
    fn notice_says_what_it_waits_for() {
        let mut waiting = entry("a", AttentionState::NeedsInput, true, false);
        waiting.attention.ask = Some(AskKind::Approval);
        waiting.attention.preview = None;
        assert_eq!(notice(&waiting).body, "等你批准");
        let failed = entry("b", AttentionState::Failed, true, false);
        assert_eq!(notice(&failed).body, "失败了：改好了");
    }

    #[test]
    fn badge_is_a_filled_dot_with_dark_digits() {
        let pixels = badge_pixels(3);
        assert_eq!(pixels.len(), (BADGE_SIZE * BADGE_SIZE * 4) as usize);
        let at = |x: u32, y: u32| ((y * BADGE_SIZE + x) * 4) as usize;
        assert_eq!(pixels[at(0, 0) + 3], 0);
        let ink = pixels.chunks(4).filter(|px| px == &[0x1a, 0x1a, 0x1a, 0xff]).count();
        // 「3」有 11 个点，放大两倍是 44 个像素。
        assert_eq!(ink, 44);
        assert!(pixels.chunks(4).any(|px| px[..3] == BADGE_FILL));
        assert!(badge_pixels(12).chunks(4).any(|px| px == [0x1a, 0x1a, 0x1a, 0xff]));
    }
}
