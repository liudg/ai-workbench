//! 子任务结果怎么回到父任务。照 Claude Code 桌面版嵌套会话：父会话不用挂着等，
//! 所有子任务都停下、父会话也空闲时，一次把结果发给父会话，叫醒它开一个新回合。
//!
//! - 父任务驱动的回合（开出来的第一轮、父任务追加的消息）停在完成或等输入时，可以叫醒父会话。
//! - 用户自己在子任务里发消息开的回合，以及被打断或失败的回合，不叫醒，留到用户下一次在父会话发消息时一起带上。
//! - 连续叫醒 [`MAX_WAKES`] 次、中间用户一条消息都没发，后面的也留到用户下一条消息，防止父子来回空转。
//! - 卡片的结果（用户点了「另开」或「就在这做」）是用户的操作，父会话空闲就送，不等子任务。
//!
//! 只在内存里：daemon 重启后会话都记成已停止，没送出的结果不再送。

use std::collections::{HashMap, HashSet};

use aiwb_core::models::SessionStatus;

pub(crate) const MAX_WAKES: u32 = 3;

/// 子任务现在的回合是谁让跑的。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Driver {
    Parent,
    User,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Note {
    pub(crate) text: String,
    pub(crate) task_ids: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Outcome {
    pub(crate) status: SessionStatus,
    /// 这个结果能叫醒父会话。
    pub(crate) wake: bool,
}

/// 一次送给父会话的内容。
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Batch {
    pub(crate) notes: Vec<Note>,
    pub(crate) results: Vec<(String, Outcome)>,
}

#[derive(Default)]
struct Inbox {
    notes: Vec<Note>,
    /// 每个子任务只留最新一个结果。
    results: Vec<(String, Outcome)>,
    /// 刚开出、第一个回合还没结束的子任务。CLI 起来之前它的状态还是「已完成」，不能当成停下了。
    starting: Vec<String>,
    /// 正在开的批数。开完之前不叫醒。
    holding: u32,
    /// 用户上一次发消息之后，结果叫醒了父会话几次。
    wakes: u32,
}

#[derive(Default)]
pub(crate) struct Reports {
    inboxes: HashMap<String, Inbox>,
    drivers: HashMap<String, Driver>,
    /// 删掉或归档了的子任务。停进程时晚到的状态不再记成结果。
    gone: HashSet<String>,
}

impl Reports {
    pub(crate) fn drive(&mut self, child: &str, driver: Driver) {
        self.drivers.insert(child.to_string(), driver);
    }

    /// 父任务开出了子任务，第一条消息还在路上。
    /// 子任务跑得比这里记得快、第一个回合已经结束时不再记。
    pub(crate) fn opened(&mut self, parent: &str, child: &str) {
        self.drivers.insert(child.to_string(), Driver::Parent);
        let inbox = self.inboxes.entry(parent.to_string()).or_default();
        if !inbox.results.iter().any(|(id, _)| id == child) {
            inbox.starting.push(child.to_string());
        }
    }

    pub(crate) fn hold(&mut self, parent: &str) {
        self.inboxes.entry(parent.to_string()).or_default().holding += 1;
    }

    pub(crate) fn release(&mut self, parent: &str) {
        if let Some(inbox) = self.inboxes.get_mut(parent) {
            inbox.holding = inbox.holding.saturating_sub(1);
        }
    }

    /// 用户在父会话说了话，重新开始数叫醒次数。
    pub(crate) fn user_spoke(&mut self, parent: &str) {
        if let Some(inbox) = self.inboxes.get_mut(parent) {
            inbox.wakes = 0;
        }
    }

    /// 任务没了（删掉或归档）：作为子任务不再等它、不送它的结果；作为父任务丢掉它的收件箱。
    pub(crate) fn forget(&mut self, task: &str) {
        self.drivers.remove(task);
        self.inboxes.remove(task);
        self.gone.insert(task.to_string());
        for inbox in self.inboxes.values_mut() {
            inbox.starting.retain(|id| id != task);
            inbox.results.retain(|(id, _)| id != task);
        }
    }

    /// 取消归档：之后的回合照常回报。
    pub(crate) fn revive(&mut self, task: &str) {
        self.gone.remove(task);
    }

    /// 有没有要送给这个父任务的东西。
    pub(crate) fn pending(&self, parent: &str) -> bool {
        self.inboxes
            .get(parent)
            .is_some_and(|inbox| !inbox.notes.is_empty() || !inbox.results.is_empty())
    }

    /// 这个任务手上还有事：它开的子任务还没起来，或者有结果等着叫醒它。它的状态这时可能是「已完成」，
    /// 但它很快还会做一轮，上面的任务不能当它停下了。
    pub(crate) fn expecting(&self, task: &str) -> bool {
        self.inboxes.get(task).is_some_and(|inbox| {
            !inbox.starting.is_empty()
                || inbox.holding > 0
                || (inbox.wakes < MAX_WAKES && inbox.results.iter().any(|(_, outcome)| outcome.wake))
        })
    }

    /// 子任务的回合停下了。还在跑的状态不用记。
    pub(crate) fn turn_ended(&mut self, parent: &str, child: &str, status: SessionStatus) {
        if status == SessionStatus::Running || self.gone.contains(child) {
            return;
        }
        let by_parent = self.drivers.get(child) != Some(&Driver::User);
        let wake = by_parent && matches!(status, SessionStatus::Completed | SessionStatus::NeedsInput);
        let inbox = self.inboxes.entry(parent.to_string()).or_default();
        inbox.starting.retain(|id| id != child);
        match inbox.results.iter_mut().find(|(id, _)| id == child) {
            // 前一个能叫醒的结果还没送出去，新结果也照样能叫醒。
            Some((_, outcome)) => {
                *outcome = Outcome {
                    status,
                    wake: wake || outcome.wake,
                }
            }
            None => inbox.results.push((child.to_string(), Outcome { status, wake })),
        }
    }

    pub(crate) fn note(&mut self, parent: &str, note: Note) {
        self.inboxes.entry(parent.to_string()).or_default().notes.push(note);
    }

    /// 父会话空闲了，看要不要叫醒它。`descendants_working`：下面还有任务没做完。
    pub(crate) fn take_for_wake(&mut self, parent: &str, descendants_working: bool) -> Option<Batch> {
        let inbox = self.inboxes.get_mut(parent)?;
        let wake = !descendants_working
            && inbox.starting.is_empty()
            && inbox.holding == 0
            && inbox.wakes < MAX_WAKES
            && inbox.results.iter().any(|(_, outcome)| outcome.wake);
        if wake {
            inbox.wakes += 1;
            return Some(Batch {
                notes: std::mem::take(&mut inbox.notes),
                results: std::mem::take(&mut inbox.results),
            });
        }
        if inbox.notes.is_empty() {
            return None;
        }
        inbox.wakes = 0;
        Some(Batch {
            notes: std::mem::take(&mut inbox.notes),
            results: Vec::new(),
        })
    }

    /// 用户在父会话发消息：没送出的全部带上，重新开始数叫醒次数。
    pub(crate) fn take_for_user(&mut self, parent: &str) -> Option<Batch> {
        let inbox = self.inboxes.get_mut(parent)?;
        inbox.wakes = 0;
        if inbox.notes.is_empty() && inbox.results.is_empty() {
            return None;
        }
        Some(Batch {
            notes: std::mem::take(&mut inbox.notes),
            results: std::mem::take(&mut inbox.results),
        })
    }

    /// 发送失败，放回去下次再送。期间来的新结果更新，留着新的。
    pub(crate) fn restore(&mut self, parent: &str, batch: Batch) {
        let inbox = self.inboxes.entry(parent.to_string()).or_default();
        let mut notes = batch.notes;
        notes.append(&mut inbox.notes);
        inbox.notes = notes;
        for (child, outcome) in batch.results {
            if !inbox.results.iter().any(|(id, _)| *id == child) {
                inbox.results.push((child, outcome));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(batch: &Batch) -> Vec<&str> {
        batch.results.iter().map(|(id, _)| id.as_str()).collect()
    }

    #[test]
    fn a_task_with_results_on_the_way_is_not_stopped() {
        let mut reports = Reports::default();
        assert!(!reports.expecting("mid"));
        reports.opened("mid", "leaf");
        assert!(reports.expecting("mid"), "孙任务还没起来");
        reports.turn_ended("mid", "leaf", SessionStatus::Completed);
        assert!(reports.expecting("mid"), "结果等着叫醒它");
        assert!(reports.take_for_wake("mid", false).is_some());
        assert!(!reports.expecting("mid"));
    }

    #[test]
    fn waits_until_every_subtask_stops_then_reports_once() {
        let mut reports = Reports::default();
        reports.turn_ended("p", "a", SessionStatus::Completed);
        assert_eq!(reports.take_for_wake("p", true), None, "b 还在跑");
        reports.turn_ended("p", "b", SessionStatus::NeedsInput);
        let batch = reports.take_for_wake("p", false).unwrap();
        assert_eq!(ids(&batch), ["a", "b"]);
        assert_eq!(reports.take_for_wake("p", false), None, "只回报一次");
    }

    #[test]
    fn a_subtask_whose_cli_is_still_starting_counts_as_working() {
        let mut reports = Reports::default();
        reports.opened("p", "a");
        reports.opened("p", "b");
        reports.turn_ended("p", "a", SessionStatus::Completed);
        assert_eq!(reports.take_for_wake("p", false), None, "b 的回合还没开始");
        reports.turn_ended("p", "b", SessionStatus::Completed);
        assert_eq!(ids(&reports.take_for_wake("p", false).unwrap()), ["a", "b"]);
    }

    #[test]
    fn a_removed_subtask_no_longer_holds_the_parent_back() {
        let mut reports = Reports::default();
        reports.opened("p", "a");
        reports.opened("p", "gone");
        reports.turn_ended("p", "a", SessionStatus::Completed);
        assert_eq!(reports.take_for_wake("p", false), None);
        reports.forget("gone");
        // 停进程时晚到的状态不再记。
        reports.turn_ended("p", "gone", SessionStatus::Stopped);
        assert_eq!(ids(&reports.take_for_wake("p", false).unwrap()), ["a"]);
    }

    #[test]
    fn nothing_wakes_the_parent_while_a_batch_is_being_opened() {
        let mut reports = Reports::default();
        reports.hold("p");
        reports.hold("p");
        reports.turn_ended("p", "a", SessionStatus::Completed);
        reports.release("p");
        assert_eq!(reports.take_for_wake("p", false), None, "另一批还在开");
        reports.release("p");
        assert!(reports.take_for_wake("p", false).is_some());
    }

    #[test]
    fn user_driven_interrupted_and_failed_turns_wait_for_the_users_next_message() {
        let mut reports = Reports::default();
        reports.drive("a", Driver::User);
        reports.turn_ended("p", "a", SessionStatus::Completed);
        reports.turn_ended("p", "b", SessionStatus::Stopped);
        reports.turn_ended("p", "c", SessionStatus::Failed);
        assert_eq!(reports.take_for_wake("p", false), None);
        let batch = reports.take_for_user("p").unwrap();
        assert_eq!(ids(&batch), ["a", "b", "c"]);

        // 父任务再追加消息，这个子任务的结果又能叫醒。
        reports.drive("a", Driver::Parent);
        reports.turn_ended("p", "a", SessionStatus::Completed);
        assert!(reports.take_for_wake("p", false).is_some());
    }

    #[test]
    fn repeated_wakes_without_the_user_stop_until_the_user_speaks() {
        let mut reports = Reports::default();
        for _ in 0..MAX_WAKES {
            reports.turn_ended("p", "a", SessionStatus::Completed);
            assert!(reports.take_for_wake("p", false).is_some());
        }
        reports.turn_ended("p", "a", SessionStatus::Completed);
        assert_eq!(reports.take_for_wake("p", false), None);
        // 父会话在跑时用户说话也算，回报接着叫醒。
        reports.user_spoke("p");
        assert_eq!(ids(&reports.take_for_wake("p", false).unwrap()), ["a"]);
        reports.turn_ended("p", "a", SessionStatus::Completed);
        assert!(reports.take_for_wake("p", false).is_some(), "用户说过话，重新数");
    }

    #[test]
    fn card_results_go_out_without_waiting_for_subtasks() {
        let mut reports = Reports::default();
        reports.turn_ended("p", "a", SessionStatus::Completed);
        reports.note(
            "p",
            Note {
                text: "已开出".into(),
                task_ids: vec!["b".into()],
            },
        );
        let batch = reports.take_for_wake("p", true).unwrap();
        assert_eq!(batch.notes.len(), 1);
        assert!(batch.results.is_empty(), "b 还在跑，a 的结果等着");
        assert_eq!(ids(&reports.take_for_wake("p", false).unwrap()), ["a"]);
    }

    #[test]
    fn a_failed_send_is_put_back() {
        let mut reports = Reports::default();
        reports.turn_ended("p", "a", SessionStatus::Completed);
        let batch = reports.take_for_wake("p", false).unwrap();
        reports.turn_ended("p", "a", SessionStatus::NeedsInput);
        reports.restore("p", batch);
        let again = reports.take_for_user("p").unwrap();
        assert_eq!(again.results, [("a".to_string(), Outcome { status: SessionStatus::NeedsInput, wake: true })]);
    }
}
