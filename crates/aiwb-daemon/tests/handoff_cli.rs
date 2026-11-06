//! 用本机真实的 Codex 和 Claude Code 走一遍跨 Agent 交接和分叉。要登录过的 CLI，会花模型额度。
//! `cargo test -p aiwb-daemon --test handoff_cli -- --ignored --nocapture`

use std::sync::Arc;
use std::time::{Duration, Instant};

use aiwb_core::DaemonInfo;
use aiwb_daemon::Services;
use aiwb_store::Store;
use serde_json::{json, Value};

fn events_of(feed: &Value) -> Vec<Value> {
    feed["events"].as_array().cloned().unwrap_or_default()
}

/// 发一条消息，等这一段多出一条回答并停在已完成，返回最后一条回答。
async fn ask(services: &Services, session_id: &str, text: &str) -> String {
    let topic = format!("session:{session_id}");
    let replies = |events: &[Value]| events.iter().filter(|e| e["kind"] == "agent-message").count();
    let before = replies(&events_of(&services.snapshot(&topic, &json!({})).unwrap()));
    services
        .dispatch("sessions.send", json!({ "sessionId": session_id, "text": text }))
        .await
        .unwrap_or_else(|err| panic!("发送失败：{err}"));
    let started = Instant::now();
    loop {
        let events = events_of(&services.snapshot(&topic, &json!({})).unwrap());
        let status = events
            .iter()
            .rev()
            .find(|e| e["kind"] == "status-changed")
            .map(|e| e["status"].as_str().unwrap_or("").to_string());
        if matches!(status.as_deref(), Some("failed")) {
            panic!("回合失败：{}", serde_json::to_string_pretty(&events).unwrap());
        }
        if replies(&events) > before && status.as_deref() == Some("completed") {
            let answer = events
                .iter()
                .rev()
                .find(|e| e["kind"] == "agent-message")
                .and_then(|e| e["text"].as_str())
                .unwrap_or_default()
                .to_string();
            println!("[{session_id}] {text}\n  → {answer}");
            return answer;
        }
        if started.elapsed() > Duration::from_secs(240) {
            panic!("等回答超时：{}", serde_json::to_string_pretty(&events).unwrap());
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

fn last_session(entry: &Value) -> (String, Value) {
    let sessions = entry["sessions"].as_array().unwrap();
    let last = sessions.last().unwrap().clone();
    (last["id"].as_str().unwrap().to_string(), last)
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "calls the local Codex and Claude Code CLIs"]
async fn multiple_temporary_chats_with_native_clis() {
    let data = tempfile::tempdir().unwrap();
    let project_dir = tempfile::tempdir().unwrap();
    let services = Services::new(
        Arc::new(Store::open(&data.path().join("db.sqlite")).unwrap()),
        DaemonInfo { version: "cli".into(), build: String::new(), pid: 1, port: 0, token: "t".into() },
        data.path().to_path_buf(),
    );
    let project = services.dispatch("projects.add", json!({ "path": project_dir.path().to_string_lossy() })).await.unwrap();
    for agent in ["codex-cli", "claude-code"] {
        let task = services.dispatch("tasks.create", json!({ "projectId": project["id"], "agent": agent })).await.unwrap();
        let (main, _) = last_session(&task);
        ask(&services, &main, "Remember the code PLUM-42. Reply OK only. Do not use tools.").await;
        let (a, b) = tokio::join!(
            services.dispatch("tasks.openSide", json!({ "taskId": task["id"] })),
            services.dispatch("tasks.openSide", json!({ "taskId": task["id"] }))
        );
        let (a, b) = (a.unwrap(), b.unwrap());
        assert_ne!(a["id"], b["id"]);
        let (aid, bid) = (a["id"].as_str().unwrap(), b["id"].as_str().unwrap());
        let (answer_a, answer_b) = tokio::join!(
            ask(&services, aid, "What code did I ask you to remember? Reply only the code. Do not use tools."),
            ask(&services, bid, "What code did I ask you to remember? Reply only the code. Do not use tools.")
        );
        assert!(answer_a.contains("PLUM-42"), "{agent}: {answer_a}");
        assert!(answer_b.contains("PLUM-42"), "{agent}: {answer_b}");
        services.dispatch("tasks.closeSide", json!({ "sessionId": aid })).await.unwrap();
        assert!(services.snapshot(&format!("session:{bid}"), &json!({})).is_ok());
        services.dispatch("tasks.closeSide", json!({ "sessionId": bid })).await.unwrap();
        services.stop_agents().await;
    }
}

fn handoff_of(services: &Services, session_id: &str) -> Value {
    events_of(&services.snapshot(&format!("session:{session_id}"), &json!({})).unwrap())
        .into_iter()
        .find(|e| e["kind"] == "handoff")
        .expect("这一段有交接")
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "calls the local Codex and Claude Code CLIs"]
async fn codex_and_claude_hand_off_and_fork() {
    let data = tempfile::tempdir().unwrap();
    let project_dir = tempfile::tempdir().unwrap();
    let info = DaemonInfo {
        version: "cli".into(),
        build: String::new(),
        pid: 1,
        port: 0,
        token: "t".into(),
    };
    let services = Services::new(
        Arc::new(Store::open(&data.path().join("db.sqlite")).unwrap()),
        info,
        data.path().to_path_buf(),
    );
    let project = services
        .dispatch("projects.add", json!({ "path": project_dir.path().to_string_lossy() }))
        .await
        .unwrap();
    let task = services
        .dispatch("tasks.create", json!({ "projectId": project["id"], "agent": "codex-cli" }))
        .await
        .unwrap();
    let task_id = task["id"].as_str().unwrap().to_string();
    let (codex, _) = last_session(&task);
    ask(&services, &codex, "记住第一个暗号：PLUM-42。不要用工具，只回复：好").await;

    // Codex → Claude：新线程，带上全部前文。
    let switched = services
        .dispatch("tasks.switchAgent", json!({ "taskId": task_id, "agent": "claude-code" }))
        .await
        .unwrap();
    let (claude, _) = last_session(&switched);
    let answer = ask(&services, &claude, "第一个暗号是什么？不要用工具，只回复暗号本身").await;
    assert!(answer.contains("PLUM-42"), "Claude 没拿到前文：{answer}");
    let handoff = handoff_of(&services, &claude);
    assert_eq!(handoff["strategy"], "full");
    assert_eq!(handoff["delivered"], true);
    println!("交给 Claude：{handoff}");
    ask(&services, &claude, "再记住第二个暗号：KIWI-7。不要用工具，只回复：好").await;

    // Claude → Codex：接回原来的线程，只补 Claude 那段。
    let back = services
        .dispatch("tasks.switchAgent", json!({ "taskId": task_id, "agent": "codex-cli" }))
        .await
        .unwrap();
    let (codex_again, session) = last_session(&back);
    assert_eq!(session["nativeId"], back["sessions"][0]["nativeId"]);
    let answer = ask(&services, &codex_again, "两个暗号分别是什么？不要用工具，只回复两个暗号，用空格隔开").await;
    assert!(answer.contains("PLUM-42") && answer.contains("KIWI-7"), "Codex 没接上：{answer}");
    let handoff = handoff_of(&services, &codex_again);
    assert_eq!(handoff["strategy"], "delta");
    println!("交回 Codex：{handoff}");

    // 同一个 Agent 原生分叉。
    let forked = services
        .dispatch("tasks.fork", json!({ "taskId": task_id }))
        .await
        .unwrap();
    let (native_fork, session) = last_session(&forked);
    assert!(session["nativeId"].as_str().is_some_and(|id| id != back["sessions"][0]["nativeId"]));
    let answer = ask(&services, &native_fork, "第二个暗号是什么？不要用工具，只回复暗号本身").await;
    assert!(answer.contains("KIWI-7"), "原生分叉没带上历史：{answer}");

    // 分叉到 Claude：新线程，带上全部前文。
    let forked = services
        .dispatch("tasks.fork", json!({ "taskId": task_id, "agent": "claude-code" }))
        .await
        .unwrap();
    let (claude_fork, _) = last_session(&forked);
    let answer = ask(&services, &claude_fork, "两个暗号分别是什么？不要用工具，只回复两个暗号，用空格隔开").await;
    assert!(answer.contains("PLUM-42") && answer.contains("KIWI-7"), "分叉到 Claude 没带上前文：{answer}");

    services.stop_agents().await;
}
