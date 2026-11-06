use super::*;

#[test]
fn maps_permission_labels() {
    assert_eq!(Access::parse("完全访问"), Some(Access::Full));
    assert_eq!(Access::parse("询问批准"), Some(Access::Ask));
    assert_eq!(Access::parse("read-only"), Some(Access::ReadOnly));
    assert_eq!(Access::Full.sandbox_mode(), "danger-full-access");
    assert_eq!(Access::Full.approval_policy(), "never");
    assert_eq!(Access::Ask.sandbox_mode(), "workspace-write");
    assert_eq!(Access::Ask.approval_policy(), "on-request");
    assert_eq!(Access::ReadOnly.sandbox_mode(), "read-only");
    assert_eq!(Access::ReadOnly.approval_policy(), "on-request");
}

#[test]
fn occupied_notice_waits_until_open_finishes_and_is_once() {
    let mut occupancy = Occupancy::default();
    assert!(
        !occupancy.block(),
        "startup conflict must not announce early"
    );
    assert!(occupancy.blocked());
    assert!(occupancy.finish_open());
    assert!(!occupancy.finish_open());
    assert!(!occupancy.block());
}

#[test]
fn occupied_after_open_announces_immediately() {
    let mut occupancy = Occupancy::default();
    assert!(!occupancy.finish_open());
    assert!(occupancy.block());
    assert!(!occupancy.block());
}

/// 空闲时关进程（daemon 退出、空闲回收）不把完成的会话改成已停止；回合还开着时才记停止。
#[test]
fn stopping_an_idle_session_keeps_its_status() {
    use aiwb_core::models::{SessionEventBody, SessionStatus};
    use std::sync::atomic::Ordering;

    let stopped = |open: bool| {
        let (events_tx, mut events) = tokio::sync::mpsc::unbounded_channel();
        let (out_tx, _out) = tokio::sync::mpsc::unbounded_channel();
        let shared = Shared::for_test(events_tx, out_tx);
        shared.turn_open.store(open, Ordering::SeqCst);
        shared.stop();
        std::iter::from_fn(|| events.try_recv().ok())
            .any(|body| matches!(body, SessionEventBody::StatusChanged { status: SessionStatus::Stopped }))
    };
    assert!(!stopped(false));
    assert!(stopped(true));
}
