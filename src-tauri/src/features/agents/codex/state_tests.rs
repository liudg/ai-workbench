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
