//! Codex 会话进程的共享状态。适配器编排层和各子模块都读写这里。

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::Mutex;
use std::time::Instant;

use serde_json::Value;
use tokio::process::Child;
use tokio::sync::{mpsc, oneshot, Mutex as AsyncMutex};

use crate::features::agents::EventSink;
use crate::models::{
    MessagePhase, PromptQuestion, QueuedTurn, SessionEventBody, SessionStatus,
    OCCUPIED_SESSION_NOTICE,
};

use super::process::is_thread_writer_conflict;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Access {
    Full,
    Ask,
    ReadOnly,
}

impl Access {
    pub(super) fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "full" | "danger-full-access" | "full-access" | "完全访问" => Some(Self::Full),
            "ask" | "on-request" | "workspace-write" | "auto" | "询问批准" => Some(Self::Ask),
            "read-only" | "readonly" | "read" | "只读" => Some(Self::ReadOnly),
            _ => None,
        }
    }

    pub(super) fn label(self) -> &'static str {
        match self {
            Self::Full => "完全访问",
            Self::Ask => "询问批准",
            Self::ReadOnly => "只读",
        }
    }

    /// `thread/start` 的 sandbox 字符串。
    pub(super) fn sandbox_mode(self) -> &'static str {
        match self {
            Self::Full => "danger-full-access",
            Self::Ask => "workspace-write",
            Self::ReadOnly => "read-only",
        }
    }

    pub(super) fn approval_policy(self) -> &'static str {
        match self {
            Self::Full => "never",
            Self::Ask | Self::ReadOnly => "on-request",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Collaboration {
    Default,
    Plan,
}

impl Collaboration {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::Plan => "plan",
        }
    }
}

#[derive(Clone)]
pub(super) enum Pending {
    Approval {
        rpc_id: u64,
    },
    /// 阻塞式 requestUserInput：答案写回 JSON-RPC 响应
    UserInput {
        rpc_id: u64,
        questions: Vec<PromptQuestion>,
    },
    /// async 提问（agentMessage delivery=async）：答案经 turn/steer 写回
    AsyncQuestions {
        questions: Vec<PromptQuestion>,
    },
    Access,
    /// 计划完成后的 “实施此计划？”。
    ImplementPlan,
    /// MCP elicitation。答案写回 JSON-RPC，action 为 accept / decline / cancel。
    Elicitation {
        rpc_id: u64,
        questions: Vec<PromptQuestion>,
    },
}

pub(super) struct StreamBuf {
    pub(super) text: String,
    pub(super) last_emit: Instant,
}

/// 同一条命令、补丁或 MCP 调用的流式正文。
pub(super) struct ActivityBuf {
    pub(super) name: String,
    pub(super) summary: String,
    pub(super) detail: String,
    pub(super) images: Vec<String>,
    pub(super) last_emit: Instant,
}

pub(super) struct Shared {
    pub(super) events: EventSink,
    pub(super) out: mpsc::UnboundedSender<String>,
    pub(super) child: Mutex<Option<Child>>,
    pub(super) next_id: AtomicU64,
    pub(super) closed: AtomicBool,
    pub(super) user_stop: AtomicBool,
    pub(super) turn_open: AtomicBool,
    pub(super) access: Mutex<super::sandbox::SandboxChoice>,
    pub(super) wire: Mutex<super::sandbox::SandboxWire>,
    pub(super) wire_ready: AtomicBool,
    pub(super) model_override: Mutex<Option<String>>,
    pub(super) effort: Mutex<Option<String>>,
    pub(super) skills: Mutex<Vec<KnownSkill>>,
    pub(super) thread_id: Mutex<Option<String>>,
    /// 新线程写入 Codex resume 列表，而不是 ephemeral。
    pub(super) persist: bool,
    /// 当前回合 id（turn/started 时记录）；async 提问的回答经 turn/steer 时需要它
    pub(super) turn_id: Mutex<Option<String>>,
    pub(super) model: Mutex<String>,
    pub(super) version: Mutex<String>,
    pub(super) cwd: String,
    pub(super) pending: Mutex<HashMap<String, Pending>>,
    pub(super) waiters: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    /// 不等待结果的 JSON-RPC id → method，用来区分 turn/start 失败和其它命令失败。
    pub(super) rpc_methods: Mutex<HashMap<u64, String>>,
    pub(super) streams: Mutex<HashMap<String, StreamBuf>>,
    /// 助手消息 item id → 协议阶段。delta 通知本身不带 phase，完成时再补上。
    pub(super) message_phases: Mutex<HashMap<String, MessagePhase>>,
    /// 第一条用户消息会把 Codex 线程名写成标题。在此之前用「未命名会话」落盘。
    pub(super) titled: AtomicBool,
    /// 已渲染成问题卡片的 agentMessage item id：抑制后续的 delta / 重复文本
    pub(super) question_items: Mutex<HashSet<String>>,
    /// 另一个进程持有线程写锁时，这次打开只读。
    pub(super) occupancy: Mutex<Occupancy>,
    pub(super) queue_notify: mpsc::UnboundedSender<()>,
    pub(super) queue_refresh: AsyncMutex<()>,
    pub(super) queued: Mutex<Vec<QueuedTurn>>,
    pub(super) queue_removed: Mutex<HashSet<String>>,
    pub(super) shown_users: Mutex<HashSet<String>>,
    /// 桌面端 Plan 开关。`turn/start` 始终带当前 collaborationMode，退出计划时显式写 default。
    pub(super) collaboration: Mutex<Collaboration>,
    /// 本回合已经有可实施的计划（`turn/plan/updated` 或计划模式的 plan item），结束后问要不要实施。
    pub(super) plan_ready: AtomicBool,
    /// 退出审查时的原文，用来丢掉紧随其后的重复 agentMessage。
    pub(super) review_output: Mutex<Option<String>>,
    /// `thread/turns/list` 的下一页。空表示没有更早的回合。
    pub(super) history_cursor: Mutex<Option<String>>,
    /// 流式命令输出和补丁正文。键是 item id。
    pub(super) activity: Mutex<HashMap<String, ActivityBuf>>,
}

/// `thread/resume` 撞上 active writer 之后的打开状态。
/// 只读通知只发一次，并且等打开结束后再发，避免插在历史记录前面。
#[derive(Debug, Default)]
pub(super) struct Occupancy {
    blocked: bool,
    announced: bool,
    open: bool,
}

impl Occupancy {
    pub(super) fn blocked(&self) -> bool {
        self.blocked
    }

    /// 记下占用。会话已经完成打开时，返回 true，调用方发出只读通知。
    pub(super) fn block(&mut self) -> bool {
        self.blocked = true;
        self.announce_if_ready()
    }

    pub(super) fn finish_open(&mut self) -> bool {
        self.open = true;
        self.announce_if_ready()
    }

    fn announce_if_ready(&mut self) -> bool {
        if self.blocked && self.open && !self.announced {
            self.announced = true;
            true
        } else {
            false
        }
    }
}

#[derive(Clone)]
pub(super) struct KnownSkill {
    pub(super) name: String,
    pub(super) mention: String,
    pub(super) label: String,
    pub(super) description: String,
    pub(super) path: String,
}

pub(super) fn emit(events: &EventSink, body: SessionEventBody) {
    let _ = events.send(body);
}

pub(super) fn emit_status(events: &EventSink, status: SessionStatus) {
    emit(events, SessionEventBody::StatusChanged { status });
}

impl Shared {
    pub(super) fn read_only(&self) -> bool {
        self.occupancy.lock().unwrap().blocked()
    }

    /// 写锁冲突不是会话失败。返回 true 时调用方不要再记 Error / Failed。
    pub(super) fn reject_writer_conflict(&self, message: &str) -> bool {
        if !is_thread_writer_conflict(message) {
            return false;
        }
        self.mark_occupied();
        true
    }

    pub(super) fn finish_open(&self) {
        let announce = self.occupancy.lock().unwrap().finish_open();
        if announce {
            emit_occupied(&self.events);
        }
    }

    fn mark_occupied(&self) {
        let announce = self.occupancy.lock().unwrap().block();
        if announce {
            emit_occupied(&self.events);
        }
    }
}

fn emit_occupied(events: &EventSink) {
    emit(
        events,
        SessionEventBody::ReadOnly {
            text: OCCUPIED_SESSION_NOTICE.to_string(),
        },
    );
}

#[cfg(test)]
mod tests {
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
}
