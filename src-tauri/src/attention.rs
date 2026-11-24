//! 应用壳作为 daemon 的一个客户端订阅任务列表：会话停下来要你看时发系统通知，
//! 等着你的会话数挂到任务栏角标和托盘提示上。窗口关着（藏在托盘里）也照样提醒。
//!
//! 未读由 daemon 按「有没有人正看着」记，所以正在看的会话跑完不会弹通知。
//! 照 orca `src/renderer/src/attention/agent-attention-policy.ts`（要你处理、已完成两类）
//! 和 `src/main/notifications/notification-delivery-service.ts`。
//!
//! 变成未读后先等一小会儿再弹：会话马上又接着做（Claude Code 的后台任务跑完约 0.1 秒后自己开一轮）就不弹，
//! 一件事做完只提醒一次。角标照旧立刻更新。

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use aiwb_core::attention::{AskKind, Attention, AttentionState};
use aiwb_core::rpc::{Push, TOPIC_TASKS};
use aiwb_core::task::TaskEntry;
use futures_util::{SinkExt, StreamExt};
use tauri::image::Image;
use tauri::{AppHandle, Manager, UserAttentionType};
use tauri_plugin_notification::NotificationExt;
use tokio_tungstenite::tungstenite::Message;

const RETRY: Duration = Duration::from_secs(2);
/// 变成未读到弹通知之间等的时间。
const GRACE: Duration = Duration::from_secs(2);

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
    loop {
        let due = watcher.next_due();
        tokio::select! {
            message = socket.next() => {
                let Some(message) = message else { break };
                if let Some(entries) = task_entries(message.map_err(|e| e.to_string())?) {
                    show_waiting(app, watcher.update(&entries, Instant::now()));
                }
            }
            _ = tokio::time::sleep_until(due.unwrap_or_else(Instant::now).into()), if due.is_some() => {}
        }
        notify(app, &watcher.due(Instant::now()));
    }
    Ok(())
}

fn task_entries(message: Message) -> Option<Vec<TaskEntry>> {
    let Message::Text(text) = message else {
        return None;
    };
    let push = serde_json::from_str::<Push>(&text).ok()?;
    if push.topic != TOPIC_TASKS {
        return None;
    }
    serde_json::from_value(push.data).ok()
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
    /// 刚变成未读、还没到时间弹的提醒，按任务。
    pending: HashMap<String, (Notice, Instant)>,
}

impl Watcher {
    fn reset(&mut self) {
        self.unread = None;
        self.pending.clear();
    }

    /// 收下一份任务列表，返回等着你的会话数。
    fn update(&mut self, entries: &[TaskEntry], now: Instant) -> usize {
        let live: Vec<&TaskEntry> = entries.iter().filter(|entry| entry.task.archived_at.is_none()).collect();
        let unread: HashMap<&str, &TaskEntry> = live
            .iter()
            .filter(|entry| entry.attention.unread)
            .map(|entry| (entry.task.id.as_str(), *entry))
            .collect();
        // 已经不是未读（又接着做了、看过了、归档了）的不再弹；还在等的换成最新的说法。
        self.pending.retain(|id, (waiting, _)| match unread.get(id.as_str()) {
            Some(entry) => {
                *waiting = notice(entry);
                true
            }
            None => false,
        });
        if let Some(before) = &self.unread {
            for (id, entry) in &unread {
                if !before.get(*id).copied().unwrap_or(false) {
                    self.pending.insert(id.to_string(), (notice(entry), now + GRACE));
                }
            }
        }
        self.unread = Some(
            live.iter()
                .map(|entry| (entry.task.id.clone(), entry.attention.unread))
                .collect(),
        );
        live.iter().filter(|entry| waits_for_you(&entry.attention)).count()
    }

    /// 最早到时间的提醒。
    fn next_due(&self) -> Option<Instant> {
        self.pending.values().map(|(_, at)| *at).min()
    }

    /// 取出到时间的提醒。
    fn due(&mut self, now: Instant) -> Vec<Notice> {
        let ready: Vec<String> =
            self.pending.iter().filter(|(_, (_, at))| *at <= now).map(|(id, _)| id.clone()).collect();
        ready.into_iter().filter_map(|id| self.pending.remove(&id)).map(|(notice, _)| notice).collect()
    }
}

/// 和前端 `needsYou` 同一条规则。
fn waits_for_you(attention: &Attention) -> bool {
    match attention.state {
        AttentionState::NeedsInput => true,
        AttentionState::Done | AttentionState::Failed => attention.unread,
        AttentionState::Starting | AttentionState::New | AttentionState::Working | AttentionState::Idle => false,
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

fn notify(app: &AppHandle, notices: &[Notice]) {
    if notices.is_empty() {
        return;
    }
    for notice in notices {
        let _ = app
            .notification()
            .builder()
            .title(&notice.title)
            .body(&notice.body)
            .show();
    }
    if let Some(window) = app.get_webview_window("main") {
        if !window.is_focused().unwrap_or(false) {
            let _ = window.request_user_attention(Some(UserAttentionType::Informational));
        }
    }
}

fn show_waiting(app: &AppHandle, waiting: usize) {
    if let Some(window) = app.get_webview_window("main") {
        set_badge(&window, waiting);
    }
    if let Some(tray) = app.tray_by_id(crate::tray::TRAY_ID) {
        let tooltip = match waiting {
            0 => crate::tray::APP_TITLE.to_string(),
            n => format!("{} · {n} 个会话等着你", crate::tray::APP_TITLE),
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
                instance_id: None,
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
            sides: Vec::new(),
            branch: None,
        }
    }

    /// 收一份列表，过了等待时间后弹出的提醒和等着你的会话数。
    fn settle(watcher: &mut Watcher, entries: &[TaskEntry], now: Instant) -> (Vec<Notice>, usize) {
        let waiting = watcher.update(entries, now);
        (watcher.due(now + GRACE), waiting)
    }

    #[test]
    fn startup_never_notifies_or_increments_the_badge() {
        let mut watcher = Watcher::default();
        let now = Instant::now();
        watcher.update(&[], now);
        for state in [AttentionState::New, AttentionState::Starting, AttentionState::Working] {
            let (notices, waiting) = settle(&mut watcher, &[entry("a", state, false, false)], now);
            assert!(notices.is_empty());
            assert_eq!(waiting, 0);
        }
        let (notices, waiting) = settle(&mut watcher, &[entry("a", AttentionState::Done, true, false)], now);
        assert_eq!(waiting, 1);
        assert_eq!(notices.len(), 1);
    }

    #[test]
    fn first_snapshot_only_counts_and_new_unread_notifies_once() {
        let mut watcher = Watcher::default();
        let now = Instant::now();
        let (notices, waiting) = settle(
            &mut watcher,
            &[
                entry("a", AttentionState::Done, true, false),
                entry("b", AttentionState::Working, false, false),
                entry("c", AttentionState::NeedsInput, false, false),
                entry("old", AttentionState::Failed, true, true),
            ],
            now,
        );
        assert!(notices.is_empty());
        assert_eq!(waiting, 2);

        let (notices, waiting) = settle(
            &mut watcher,
            &[
                entry("a", AttentionState::Done, true, false),
                entry("b", AttentionState::Done, true, false),
                entry("c", AttentionState::NeedsInput, false, false),
            ],
            now,
        );
        assert_eq!(notices, vec![Notice { title: "任务b".into(), body: "完成了：改好了".into() }]);
        assert_eq!(waiting, 3);

        // 同一个未读不再提醒；断线重连后的快照也不算变化。
        assert!(settle(&mut watcher, &[entry("b", AttentionState::Done, true, false)], now).0.is_empty());
        watcher.reset();
        assert!(settle(&mut watcher, &[entry("z", AttentionState::Failed, true, false)], now).0.is_empty());
    }

    /// 刚完成又马上接着做的不弹；角标立刻跟着变；等够了才弹，弹的是最新的说法。
    #[test]
    fn notice_waits_and_is_dropped_when_the_session_resumes() {
        let mut watcher = Watcher::default();
        let start = Instant::now();
        watcher.update(&[entry("a", AttentionState::Working, false, false)], start);
        assert_eq!(watcher.update(&[entry("a", AttentionState::Done, true, false)], start), 1);
        assert!(watcher.due(start + GRACE / 2).is_empty(), "还没到时间");
        assert_eq!(watcher.next_due(), Some(start + GRACE));
        watcher.update(&[entry("a", AttentionState::Working, false, false)], start + GRACE / 2);
        assert!(watcher.due(start + GRACE * 2).is_empty(), "又接着做了，不弹");
        assert_eq!(watcher.next_due(), None);

        let later = start + GRACE * 3;
        watcher.update(&[entry("a", AttentionState::Done, true, false)], later);
        let mut failed = entry("a", AttentionState::Failed, true, false);
        failed.attention.preview = Some("编译不过".into());
        watcher.update(&[failed], later);
        assert_eq!(
            watcher.due(later + GRACE),
            vec![Notice { title: "任务a".into(), body: "失败了：编译不过".into() }]
        );
        assert!(watcher.due(later + GRACE * 2).is_empty(), "只弹一次");
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
