use std::sync::Arc;

use aiwb_core::models::{AgentKind, SessionEvent, SessionStatus};
use aiwb_core::task::{LocalHandoff, StoredEvent, Task, TaskSession, TaskWorkspace};
use aiwb_core::{DaemonInfo, Project};
use aiwb_daemon::Services;
use aiwb_store::Store;
use serde_json::{json, Value};

fn fixture(workspace: TaskWorkspace) -> (tempfile::TempDir, Arc<Store>, Services) {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open_in_memory().unwrap());
    store
        .insert_project(&Project {
            id: "p".into(),
            name: "项目".into(),
            path: "C:/项目/root".into(),
            folders: vec!["C:/项目/root".into()],
            pinned: false,
            created_at: 1,
            updated_at: 1,
        })
        .unwrap();
    store
        .insert_task(
            &Task {
                id: "t".into(),
                project_id: if matches!(workspace, TaskWorkspace::Folder { .. }) {
                    None
                } else {
                    Some("p".into())
                },
                title: "会话 [完整]".into(),
                workspace,
                parent_task_id: None,
                pinned: false,
                archived_at: Some(9),
                created_at: 1,
                updated_at: 9,
            },
            &session("s1", AgentKind::CodexCli, 1),
        )
        .unwrap();
    let services = Services::with_adapters(
        store.clone(),
        DaemonInfo {
            version: "test".into(),
            build: String::new(),
            pid: 1,
            port: 0,
            token: "test".into(),
        },
        dir.path().to_path_buf(),
        Arc::new(|_| panic!("复制不应启动或访问 Agent")),
    );
    (dir, store, services)
}

fn session(id: &str, agent: AgentKind, created_at: i64) -> TaskSession {
    TaskSession {
        id: id.into(),
        task_id: "t".into(),
        agent,
        native_id: None,
        status: SessionStatus::Completed,
        options: Default::default(),
        created_at,
        updated_at: created_at,
    }
}

fn put(store: &Store, session_id: &str, seq: u64, body: Value) {
    store
        .put_event(
            "t",
            &StoredEvent {
                rev: seq + 1,
                event: SessionEvent {
                    id: format!("{session_id}-{seq}"),
                    session_id: session_id.into(),
                    seq,
                    ts: seq as i64,
                    body: serde_json::from_value(body).unwrap(),
                },
            },
            false,
            None,
        )
        .unwrap();
}

#[tokio::test]
async fn copy_workdir_resolves_root_worktree_handoff_and_standalone_without_mutation() {
    let (dir, store, services) = fixture(TaskWorkspace::Root);
    assert_eq!(
        services
            .dispatch("tasks.workdir", json!({"id":"t"}))
            .await
            .unwrap(),
        "C:/项目/root"
    );
    let tree = TaskWorkspace::Worktree {
        path: "C:/worktrees/独立分支".into(),
        branch: None,
        base_ref: None,
        base_sha: "base".into(),
        shelved: None,
        local: None,
    };
    store.set_task_workspace("t", &tree).unwrap();
    assert_eq!(
        services
            .dispatch("tasks.workdir", json!({"id":"t"}))
            .await
            .unwrap(),
        "C:/worktrees/独立分支"
    );
    let mut local = tree;
    if let TaskWorkspace::Worktree { local, .. } = &mut local {
        *local = Some(LocalHandoff {
            branch: "feature".into(),
            previous_branch: None,
            previous_head: "old".into(),
        });
    }
    store.set_task_workspace("t", &local).unwrap();
    assert_eq!(
        services
            .dispatch("tasks.workdir", json!({"id":"t"}))
            .await
            .unwrap(),
        "C:/项目/root"
    );
    assert_eq!(store.task("t").unwrap().unwrap().workspace, local);
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);

    let (_dir, _store, standalone) = fixture(TaskWorkspace::Folder {
        path: "D:/聊天/未归属项目".into(),
    });
    assert_eq!(
        standalone
            .dispatch("tasks.workdir", json!({"id":"t"}))
            .await
            .unwrap(),
        "D:/聊天/未归属项目"
    );
}

#[tokio::test]
async fn markdown_exports_all_saved_segments_and_latest_stream_text_without_logs_or_side_chat() {
    let (_dir, store, services) = fixture(TaskWorkspace::Root);
    let long = "完整历史正文。".repeat(10_000);
    put(&store, "s1", 1, json!({"kind":"user-message", "text":long}));
    put(
        &store,
        "s1",
        2,
        json!({"kind":"thinking", "text":"不应复制的思考"}),
    );
    put(
        &store,
        "s1",
        3,
        json!({"kind":"tool-call", "name":"shell", "summary":"不应复制的工具日志", "detail":"raw"}),
    );
    put(
        &store,
        "s1",
        4,
        json!({"kind":"agent-message", "text":"旧流式片段"}),
    );
    put(
        &store,
        "s1",
        4,
        json!({"kind":"agent-message", "text":"```ts\nconst x = 1;\n```\n\n第一段答复"}),
    );
    let second = session("s2", AgentKind::ClaudeCode, 2);
    store.add_session(&second).unwrap();
    put(
        &store,
        "s2",
        1,
        json!({"kind":"user-message", "text":"继续", "images":["C:/images/a [1].png", "data:image/png;base64,AAAA"]}),
    );
    put(
        &store,
        "s2",
        2,
        json!({"kind":"agent-message", "text":"完整计划", "mode":"plan"}),
    );
    put(
        &store,
        "s2",
        3,
        json!({"kind":"plan-text", "text":"完整计划"}),
    );
    put(
        &store,
        "s2",
        4,
        json!({"kind":"review-findings", "summary":"审查结论", "findings":[{"title":"边界问题", "location":"src/a.ts:2", "body":"检查空数组"}], "raw":"raw-review"}),
    );
    put(
        &store,
        "s2",
        5,
        json!({"kind":"agent-message", "text":"审查结论", "dedupe_of":"s2-4"}),
    );
    put(
        &store,
        "s2",
        6,
        json!({"kind":"agent-message", "text":"第二段答复"}),
    );
    store
        .add_side_session(&session("side", AgentKind::CursorAgent, 3))
        .unwrap();
    put(
        &store,
        "side",
        1,
        json!({"kind":"user-message", "text":"侧边聊天内容"}),
    );

    let result = services
        .dispatch("tasks.exportMarkdown", json!({"id":"t"}))
        .await
        .unwrap();
    let text = result.as_str().unwrap();
    assert!(text.starts_with("# 会话 \\[完整\\]\n"));
    assert!(text.contains(&long));
    assert!(text.contains("```ts\nconst x = 1;\n```"));
    assert!(text.contains("## Codex CLI"));
    assert!(text.contains("## Claude Code"));
    assert!(text.find("第一段答复").unwrap() < text.find("第二段答复").unwrap());
    assert!(text.contains("附件：C:/images/a \\[1\\].png"));
    assert!(text.contains("附件：内嵌图片"));
    assert_eq!(text.matches("完整计划").count(), 1);
    assert_eq!(text.matches("审查结论").count(), 1);
    assert!(text.contains("检查空数组"));
    for omitted in [
        "不应复制",
        "旧流式片段",
        "侧边聊天内容",
        "data:image",
        "raw-review",
    ] {
        assert!(!text.contains(omitted), "{omitted}");
    }
    assert_eq!(store.task("t").unwrap().unwrap().archived_at, Some(9));
}

#[tokio::test]
async fn markdown_preserves_repeated_messages_in_different_turns_and_question_answers() {
    let (_dir, store, services) = fixture(TaskWorkspace::Root);
    put(
        &store,
        "s1",
        1,
        json!({"kind":"user-message", "text":"先做计划"}),
    );
    put(
        &store,
        "s1",
        2,
        json!({"kind":"plan-text", "text":"重复正文"}),
    );
    put(
        &store,
        "s1",
        3,
        json!({"kind":"user-message", "text":"再说一次"}),
    );
    put(
        &store,
        "s1",
        4,
        json!({"kind":"agent-message", "text":"重复正文", "mode":"plan"}),
    );
    put(
        &store,
        "s1",
        5,
        json!({"kind":"prompt", "prompt_id":"q", "prompt_kind":"choice", "question":"选择语言", "options":[{"id":"ts", "label":"TypeScript"}]}),
    );
    put(
        &store,
        "s1",
        6,
        json!({"kind":"prompt-resolved", "prompt_id":"q", "answer":"TypeScript"}),
    );
    let result = services
        .dispatch("tasks.exportMarkdown", json!({"id":"t"}))
        .await
        .unwrap();
    let text = result.as_str().unwrap();
    assert_eq!(text.matches("重复正文").count(), 2);
    assert!(text.contains("选择语言"));
    assert!(text.contains("## 用户 · 回答\n\nTypeScript"));
}

#[tokio::test]
async fn markdown_preserves_generated_image_attachments_without_tool_logs() {
    let (_dir, store, services) = fixture(TaskWorkspace::Root);
    put(
        &store,
        "s1",
        1,
        json!({"kind":"user-message", "text":"生成图片"}),
    );
    put(
        &store,
        "s1",
        2,
        json!({"kind":"tool-call", "name":"image_generation", "summary":"图片已生成",
            "detail":"不应复制的生成日志", "images":["C:/images/结果 [1].png", "https://example.com/result.png", "data:image/png;base64,AAAA"]}),
    );
    put(
        &store,
        "s1",
        3,
        json!({"kind":"tool-call", "name":"view_image", "summary":"查看图片",
            "images":["C:/images/input.png"]}),
    );
    put(
        &store,
        "s1",
        4,
        json!({"kind":"tool-call", "name":"image_generation", "summary":"正在生成图片"}),
    );
    put(
        &store,
        "s1",
        5,
        json!({"kind":"agent-message", "text":"生成完成"}),
    );

    let result = services
        .dispatch("tasks.exportMarkdown", json!({"id":"t"}))
        .await
        .unwrap();
    let text = result.as_str().unwrap();
    assert!(text.contains("## Codex CLI · 图片"));
    assert!(text.contains("附件：C:/images/结果 \\[1\\].png"));
    assert!(text.contains("附件：https://example.com/result.png"));
    assert!(text.contains("附件：内嵌图片"));
    assert_eq!(text.matches("## Codex CLI · 图片").count(), 1);
    assert!(text.find("生成图片").unwrap() < text.find("附件：").unwrap());
    assert!(text.find("附件：").unwrap() < text.find("生成完成").unwrap());
    for omitted in ["不应复制", "input.png", "正在生成图片", "data:image"] {
        assert!(!text.contains(omitted), "{omitted}");
    }
}

#[tokio::test]
async fn empty_and_missing_tasks_are_handled_without_fake_content() {
    let (_dir, store, services) = fixture(TaskWorkspace::Root);
    store.set_task_title("t", "", 1).unwrap();
    assert_eq!(
        services
            .dispatch("tasks.exportMarkdown", json!({"id":"t"}))
            .await
            .unwrap(),
        "# 新会话\n"
    );
    store.remove_task("t").unwrap();
    for method in ["tasks.workdir", "tasks.exportMarkdown"] {
        assert_eq!(
            services
                .dispatch(method, json!({"id":"t"}))
                .await
                .unwrap_err(),
            "任务不存在"
        );
    }
}
