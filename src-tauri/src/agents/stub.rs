//! 适配器桩实现：不 spawn 任何真实进程，用 tokio 任务模拟一个
//! 「会流式输出、会发起审批提问」的 Agent，用于在接入真实 CLI 之前
//! 打通 UI ↔ SessionManager ↔ Adapter 全链路。
//!
//! 状态机：
//!   send_message → Running（流式回复）
//!     第一轮   → 追加 ToolCall 演示 + 发起 Approval 提问 → NeedsInput（等待 answer_prompt）
//!     之后轮次 → 直接 Completed
//!   answer_prompt → PromptResolved → AgentMessage → Completed
//!   stop → Stopped，句柄作废

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use tokio::task::JoinHandle;
use tokio::time::{sleep, Duration};

use crate::models::{
    AgentKind, PromptAnswer, PromptKind, PromptOption, SessionEventBody, SessionStatus,
};

use super::{AgentError, AgentSession, EventSink};

/// 不同 CLI 的「人格」差异，仅影响演示文案。
#[derive(Debug, Clone, Copy)]
pub struct StubPersona {
    pub cli_label: &'static str,
    #[allow(dead_code)]
    pub bin_name: &'static str,
}

#[derive(Default)]
struct StubState {
    busy: bool,
    turns: u32,
    pending_prompt: Option<String>,
    task: Option<JoinHandle<()>>,
}

pub struct StubAgentSession {
    persona: Arc<Mutex<StubPersona>>,
    events: EventSink,
    closed: Arc<AtomicBool>,
    state: Arc<Mutex<StubState>>,
}

impl StubAgentSession {
    pub fn new(persona: StubPersona, events: EventSink) -> Self {
        Self {
            persona: Arc::new(Mutex::new(persona)),
            events,
            closed: Arc::new(AtomicBool::new(false)),
            state: Arc::new(Mutex::new(StubState::default())),
        }
    }

    fn guard_open(&self) -> Result<(), AgentError> {
        if self.closed.load(Ordering::SeqCst) {
            Err(AgentError::Closed)
        } else {
            Ok(())
        }
    }
}

fn emit(events: &EventSink, body: SessionEventBody) {
    // 接收端（SessionManager 转发任务）已关闭时静默丢弃
    let _ = events.send(body);
}

#[async_trait]
impl AgentSession for StubAgentSession {
    async fn send_message(&self, text: String) -> Result<(), AgentError> {
        self.guard_open()?;

        let turn = {
            let mut st = self.state.lock().unwrap();
            if st.busy {
                return Err(AgentError::Busy);
            }
            if st.pending_prompt.is_some() {
                return Err(AgentError::PendingPrompt);
            }
            st.busy = true;
            st.turns += 1;
            st.turns
        };

        let persona = *self.persona.lock().unwrap();
        let events = self.events.clone();
        let state = Arc::clone(&self.state);

        emit(
            &events,
            SessionEventBody::StatusChanged {
                status: SessionStatus::Running,
            },
        );

        let task = tokio::spawn(async move {
            sleep(Duration::from_millis(350)).await;
            emit(
                &events,
                SessionEventBody::AgentMessage {
                    text: format!(
                        "已收到任务（{} 桩模式）：「{}」。\n\n正在分析项目上下文并规划步骤…",
                        persona.cli_label,
                        text.chars().take(48).collect::<String>(),
                    ),
                    stream_id: None,
                },
            );

            if turn == 1 {
                // 第一轮：演示工具调用 + 内联审批提问
                sleep(Duration::from_millis(600)).await;
                emit(
                    &events,
                    SessionEventBody::ToolCall {
                        name: "read_file".into(),
                        summary: "读取 src/main.rs、Cargo.toml（模拟）".into(),
                    },
                );
                sleep(Duration::from_millis(600)).await;
                emit(
                    &events,
                    SessionEventBody::ToolCall {
                        name: "apply_patch".into(),
                        summary: "计划修改 3 个文件（模拟，未真正写入）".into(),
                    },
                );
                sleep(Duration::from_millis(400)).await;
                let prompt_id = crate::models::new_id();
                emit(
                    &events,
                    SessionEventBody::Prompt {
                        prompt_id: prompt_id.clone(),
                        prompt_kind: PromptKind::Approval,
                        question: format!(
                            "{} 计划修改 3 个文件。是否允许执行？（真实 CLI 接入后，这里对应真实的工具审批）",
                            persona.cli_label
                        ),
                        options: vec![
                            PromptOption {
                                id: "approve".into(),
                                label: "允许".into(),
                                description: String::new(),
                            },
                            PromptOption {
                                id: "reject".into(),
                                label: "拒绝".into(),
                                description: String::new(),
                            },
                        ],
                        questions: Vec::new(),
                    },
                );
                {
                    let mut st = state.lock().unwrap();
                    st.pending_prompt = Some(prompt_id);
                    st.busy = false; // 等待输入期间不算忙，但 pending 会拦截新消息
                }
                emit(
                    &events,
                    SessionEventBody::StatusChanged {
                        status: SessionStatus::NeedsInput,
                    },
                );
            } else {
                sleep(Duration::from_millis(500)).await;
                emit(
                    &events,
                    SessionEventBody::AgentMessage {
                        text: "本轮任务已完成（桩模式）。接入真实 CLI 后，这里将是真实的执行结果。"
                            .into(),
                        stream_id: None,
                    },
                );
                state.lock().unwrap().busy = false;
                emit(
                    &events,
                    SessionEventBody::StatusChanged {
                        status: SessionStatus::Completed,
                    },
                );
            }
        });

        self.state.lock().unwrap().task = Some(task);
        Ok(())
    }

    async fn answer_prompt(&self, prompt_id: &str, answer: PromptAnswer) -> Result<(), AgentError> {
        self.guard_open()?;

        {
            let mut st = self.state.lock().unwrap();
            match &st.pending_prompt {
                Some(p) if p == prompt_id => {}
                _ => return Err(AgentError::UnknownPrompt(prompt_id.to_string())),
            }
            if st.busy {
                return Err(AgentError::Busy);
            }
            st.pending_prompt = None;
            st.busy = true;
        }

        let approved = match &answer {
            PromptAnswer::Single { value } => value == "approve" || value == "允许",
            PromptAnswer::Questions { skipped, .. } => !skipped,
        };
        let display = match &answer {
            PromptAnswer::Single { value } => value.clone(),
            PromptAnswer::Questions { skipped, .. } if *skipped => "已跳过".into(),
            PromptAnswer::Questions { answers, .. } => answers
                .values()
                .cloned()
                .collect::<Vec<_>>()
                .join("；"),
        };
        emit(
            &self.events,
            SessionEventBody::PromptResolved {
                prompt_id: prompt_id.to_string(),
                answer: display,
            },
        );
        emit(
            &self.events,
            SessionEventBody::StatusChanged {
                status: SessionStatus::Running,
            },
        );

        let persona = *self.persona.lock().unwrap();
        let events = self.events.clone();
        let state = Arc::clone(&self.state);
        let task = tokio::spawn(async move {
            sleep(Duration::from_millis(500)).await;
            let verdict = if approved {
                "已按你的选择继续执行（模拟）。"
            } else {
                "已取消该操作（模拟）。"
            };
            emit(
                &events,
                SessionEventBody::AgentMessage {
                    text: format!("{verdict}\n\n{} 桩会话本轮结束。", persona.cli_label),
                    stream_id: None,
                },
            );
            state.lock().unwrap().busy = false;
            emit(
                &events,
                SessionEventBody::StatusChanged {
                    status: SessionStatus::Completed,
                },
            );
        });
        self.state.lock().unwrap().task = Some(task);
        Ok(())
    }

    async fn stop(&self) -> Result<(), AgentError> {
        self.guard_open()?;
        self.closed.store(true, Ordering::SeqCst);
        if let Some(task) = self.state.lock().unwrap().task.take() {
            task.abort();
        }
        emit(
            &self.events,
            SessionEventBody::StatusChanged {
                status: SessionStatus::Stopped,
            },
        );
        Ok(())
    }

    fn retarget(&self, kind: AgentKind) {
        self.persona.lock().unwrap().cli_label = match kind {
            AgentKind::CodexCli => "Codex CLI",
            AgentKind::ClaudeCode => "Claude Code",
        };
    }
}
