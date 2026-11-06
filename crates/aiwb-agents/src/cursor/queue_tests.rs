//! 用真实调度器和 RPC 管道控制回包顺序，验证取消与续发的竞争。
use super::super::session::CursorSession;
use super::*;
use crate::{AgentSession, TurnDelivery, UserTurn};

struct Harness {
    shared: Arc<Shared>,
    session: CursorSession,
    wire: mpsc::UnboundedReceiver<String>,
    events: mpsc::UnboundedReceiver<SessionEventBody>,
}

fn turn(text: &str) -> UserTurn {
    UserTurn {
        text: text.into(),
        images: vec![],
        client_id: format!("client-{text}"),
        annotations: vec![],
    }
}

impl Harness {
    fn new() -> Self {
        let (tx, wire) = mpsc::unbounded_channel();
        let (events, rx) = mpsc::unbounded_channel();
        let project = PathBuf::from("C:/test-cursor-steering");
        let shared = Arc::new(Shared {
            events,
            map: Mutex::new(UpdateMap::new(&project)),
            subagents: Mutex::new(Subagents::new(&project)),
            project,
            rpc: Rpc::new(tx),
            child: Mutex::new(None),
            stderr: Arc::new(Mutex::new(String::new())),
            closed: AtomicBool::new(false),
            session_id: Mutex::new(Some("same-session".into())),
            catalog: Mutex::new(catalog::empty_catalog()),
            replay: Mutex::new(Replay::Live),
            prompts: Mutex::new(HashMap::new()),
            queue: Mutex::new(Default::default()),
            busy: AtomicBool::new(false),
            user_stopped: AtomicBool::new(false),
            status_lock: Mutex::new(()),
            access: Mutex::new("ask".into()),
            wanted: Mutex::new(Wanted::default()),
            config: Mutex::new(ModelConfig::default()),
            applied_plan: AtomicBool::new(false),
            instructions: Mutex::new(None),
        });
        Self {
            session: CursorSession::new(shared.clone()),
            shared,
            wire,
            events: rx,
        }
    }

    async fn next(&mut self, method: &str) -> Value {
        let line = tokio::time::timeout(Duration::from_secs(2), self.wire.recv())
            .await
            .unwrap()
            .unwrap();
        let value: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(value["method"], method, "{value}");
        assert_eq!(value["params"]["sessionId"], "same-session");
        value
    }

    fn reply(&self, request: &Value, reason: &str) {
        self.shared.rpc.resolve(
            request["id"].as_u64().unwrap(),
            Ok(json!({"stopReason":reason})),
        );
    }

    fn text(&self, text: &str) {
        self.shared
            .on_update(&json!({"sessionId":"same-session", "update":{
                "sessionUpdate":"agent_message_chunk", "content":{"type":"text", "text":text}
            }}));
    }

    fn drain(&mut self) -> Vec<SessionEventBody> {
        let mut result = vec![];
        while let Ok(event) = self.events.try_recv() {
            result.push(event);
        }
        result
    }

    fn queue(&mut self) -> Vec<aiwb_core::models::QueuedTurn> {
        self.drain()
            .into_iter()
            .filter_map(|event| match event {
                SessionEventBody::QueueChanged { items } => Some(items),
                _ => None,
            })
            .last()
            .unwrap()
    }

    async fn settled(&self) {
        tokio::time::timeout(Duration::from_secs(2), async {
            while self.shared.busy.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
}

#[tokio::test]
async fn steering_waits_for_cancel_and_preserves_order_streams_and_turn() {
    let mut h = Harness::new();
    assert_eq!(
        h.session.deliver(turn("first")).await.unwrap(),
        TurnDelivery::Started
    );
    let first = h.next("session/prompt").await;
    h.text("first answer");
    let original = h.shared.map.lock().unwrap().turn_id.clone();
    assert_eq!(
        h.session.deliver_now(turn("second")).await.unwrap(),
        TurnDelivery::Queued
    );
    h.next("session/cancel").await;
    h.session.deliver_now(turn("third")).await.unwrap();
    assert!(
        h.wire.try_recv().is_err(),
        "no prompt before cancelled response"
    );
    h.reply(&first, "cancelled");
    let second = h.next("session/prompt").await;
    assert_eq!(
        second["params"]["prompt"]
            .as_array()
            .unwrap()
            .last()
            .unwrap()["text"],
        "second"
    );
    assert!(second["params"]["prompt"]
        .as_array()
        .unwrap()
        .iter()
        .any(|block| block["text"] == "first"));
    assert!(
        h.wire.try_recv().is_err(),
        "don't cancel an unobserved prompt"
    );
    h.text("second answer");
    h.next("session/cancel").await;
    h.reply(&second, "cancelled");
    let third = h.next("session/prompt").await;
    assert_eq!(
        third["params"]["prompt"]
            .as_array()
            .unwrap()
            .last()
            .unwrap()["text"],
        "third"
    );
    for prior in ["first", "second"] {
        assert!(third["params"]["prompt"]
            .as_array()
            .unwrap()
            .iter()
            .any(|block| block["text"] == prior));
    }
    h.text("third answer");
    h.reply(&third, "end_turn");
    h.settled().await;
    assert_eq!(h.shared.map.lock().unwrap().turn_id, original);
    let events = h.drain();
    let statuses: Vec<_> = events
        .iter()
        .filter_map(|event| match event {
            SessionEventBody::StatusChanged { status } if *status != SessionStatus::Running => {
                Some(*status)
            }
            _ => None,
        })
        .collect();
    assert_eq!(statuses, vec![SessionStatus::Completed]);
    let users: Vec<_> = events
        .iter()
        .filter_map(|event| match event {
            SessionEventBody::UserMessage { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(users, vec!["second", "third"]);
    let messages: Vec<_> = events
        .iter()
        .filter_map(|event| match event {
            SessionEventBody::AgentMessage {
                text, stream_id, ..
            } => Some((text, stream_id)),
            _ => None,
        })
        .collect();
    assert_eq!(messages.len(), 3);
    assert_ne!(messages[0].1, messages[1].1);
    assert_eq!(messages[1].0, "second answer");
}

#[tokio::test]
async fn stop_during_steering_keeps_messages_and_does_not_restart() {
    let mut h = Harness::new();
    h.session.deliver(turn("first")).await.unwrap();
    let first = h.next("session/prompt").await;
    h.text("active");
    h.session.deliver_now(turn("next")).await.unwrap();
    h.next("session/cancel").await;
    h.session.interrupt().await.unwrap();
    h.next("session/cancel").await;
    h.reply(&first, "cancelled");
    h.settled().await;
    assert!(h.wire.try_recv().is_err());
    let queued = h.queue();
    assert_eq!(queued.len(), 1);
    assert_eq!(queued[0].text, "next");
    h.session.steer_queued(&queued[0].id).await.unwrap();
    let next = h.next("session/prompt").await;
    h.reply(&next, "end_turn");
    h.settled().await;
}

#[tokio::test]
async fn queued_edits_keep_identity_and_flush_respects_selected_order() {
    let mut h = Harness::new();
    h.session.deliver(turn("first")).await.unwrap();
    let first = h.next("session/prompt").await;
    h.text("active");
    for text in ["a", "b", "delete"] {
        h.session.deliver(turn(text)).await.unwrap();
    }
    let queue = h.queue();
    h.session
        .update_queued(&queue[0].id, turn("edited"))
        .await
        .unwrap();
    h.session.remove_queued(&queue[2].id).await.unwrap();
    let edited = h.queue();
    assert_eq!(edited[0].id, queue[0].id);
    assert_eq!(edited[0].client_id, queue[0].client_id);
    assert_eq!(edited[0].text, "edited");
    assert!(h
        .session
        .flush_queued(vec![queue[0].id.clone(), "missing".into()])
        .await
        .is_err());
    assert!(h.wire.try_recv().is_err());
    h.session
        .flush_queued(vec![queue[1].id.clone(), queue[0].id.clone()])
        .await
        .unwrap();
    h.next("session/cancel").await;
    h.reply(&first, "cancelled");
    let b = h.next("session/prompt").await;
    assert_eq!(
        b["params"]["prompt"].as_array().unwrap().last().unwrap()["text"],
        "b"
    );
    h.text("b answer");
    h.next("session/cancel").await;
    h.reply(&b, "cancelled");
    let a = h.next("session/prompt").await;
    assert_eq!(
        a["params"]["prompt"].as_array().unwrap().last().unwrap()["text"],
        "edited"
    );
    h.reply(&a, "end_turn");
    h.settled().await;
    // flush 不改默认模式：下一次忙时普通发送仍只排队。
    h.session.deliver(turn("again")).await.unwrap();
    let again = h.next("session/prompt").await;
    h.text("active");
    h.session.deliver(turn("held")).await.unwrap();
    assert!(h.wire.try_recv().is_err());
    h.reply(&again, "end_turn");
    let held = h.next("session/prompt").await;
    assert_eq!(held["params"]["prompt"][0]["text"], "held");
    h.reply(&held, "end_turn");
    h.settled().await;
}

#[tokio::test]
async fn pending_questions_block_steering_and_late_approvals_are_cancelled() {
    let mut h = Harness::new();
    h.session.deliver(turn("first")).await.unwrap();
    let first = h.next("session/prompt").await;
    h.text("active");
    h.shared
        .on_request(json!(80), "cursor/create_plan", &json!({}));
    assert!(matches!(
        h.session.deliver_now(turn("next")).await,
        Err(AgentError::PendingPrompt)
    ));
    h.session.deliver(turn("held")).await.unwrap();
    h.session.interrupt().await.unwrap();
    let response: Value = serde_json::from_str(&h.wire.recv().await.unwrap()).unwrap();
    assert_eq!(response["id"], 80);
    h.next("session/cancel").await;
    h.shared.set_access("full");
    h.shared
        .on_request(json!(81), "session/request_permission", &json!({}));
    let response: Value = serde_json::from_str(&h.wire.recv().await.unwrap()).unwrap();
    assert_eq!(response["result"]["outcome"]["outcome"], "cancelled");
    h.reply(&first, "cancelled");
    h.settled().await;
    assert_eq!(h.queue().len(), 1);
}

#[tokio::test]
async fn stop_before_prompt_is_written_does_not_start_a_request() {
    let mut h = Harness::new();
    h.session.deliver(turn("first")).await.unwrap();
    h.session.deliver_now(turn("next")).await.unwrap();
    h.session.interrupt().await.unwrap();
    h.settled().await;
    assert!(h.wire.try_recv().is_err());
    assert_eq!(h.queue()[0].text, "next");
}

#[tokio::test]
async fn steer_mode_keeps_images_and_failure_keeps_unsent_messages() {
    let mut h = Harness::new();
    assert!(h.session.set_follow_up_queue_mode("invalid").await.is_err());
    h.session.set_follow_up_queue_mode("steer").await.unwrap();
    h.session.deliver(turn("first")).await.unwrap();
    let first = h.next("session/prompt").await;
    h.text("active");
    let mut image_turn = turn("image");
    image_turn.images.push("data:image/png;base64,aGk=".into());
    h.session.deliver(image_turn).await.unwrap();
    h.next("session/cancel").await;
    h.reply(&first, "cancelled");
    let image = h.next("session/prompt").await;
    assert_eq!(
        image["params"]["prompt"]
            .as_array()
            .unwrap()
            .last()
            .unwrap(),
        &json!({"type":"image", "mimeType":"image/png", "data":"aGk="})
    );
    h.session
        .deliver_now(turn("keep on failure"))
        .await
        .unwrap();
    h.shared.rpc.resolve(
        image["id"].as_u64().unwrap(),
        Err(RpcError {
            code: -32603,
            message: "unavailable".into(),
        }),
    );
    h.settled().await;
    assert!(h.wire.try_recv().is_err());
    let pending = h.queue();
    assert_eq!(pending[0].text, "keep on failure");
    h.session.steer_queued(&pending[0].id).await.unwrap();
    let retry = h.next("session/prompt").await;
    let blocks = retry["params"]["prompt"].as_array().unwrap();
    assert!(blocks.iter().any(|block| block["text"] == "first"));
    assert!(blocks.iter().any(|block| block["type"] == "image"));
    h.reply(&retry, "end_turn");
    h.settled().await;
}

#[test]
fn continuation_keeps_cumulative_diff_and_closes_interrupted_tools() {
    use aiwb_core::models::ToolStatus;
    let mut map = UpdateMap::new(Path::new("C:/test"));
    map.begin_turn("turn");
    for (id, old, new) in [
        ("edit-a", "before\n", "middle\n"),
        ("edit-b", "middle\n", "after\n"),
    ] {
        map.apply(&json!({"sessionUpdate":"tool_call", "toolCallId":id, "title":"Edit", "kind":"edit", "status":"pending"}));
        map.apply(
            &json!({"sessionUpdate":"tool_call_update", "toolCallId":id, "status":"completed",
            "content":[{"type":"diff", "path":"C:/test/file.txt", "oldText":old, "newText":new}]}),
        );
        map.continue_turn();
    }
    assert!(map.last_diff.contains("-before"));
    assert!(map.last_diff.contains("+after"));
    assert!(!map.last_diff.contains("middle"));
    map.apply(&json!({"sessionUpdate":"tool_call", "toolCallId":"shell", "title":"Terminal", "kind":"execute", "status":"pending"}));
    let stopped = map.stop_tools();
    assert_eq!(stopped.len(), 1);
    assert!(
        matches!(&stopped[0], SessionEventBody::ToolCall { status: ToolStatus::Failed, detail, .. } if detail.contains("已中断"))
    );
    assert!(map.stop_tools().is_empty());
}
