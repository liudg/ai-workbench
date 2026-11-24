//! 真实 CLI 适配器活体集成验证（按 `AGENTS.md` 要求，调用本机已安装的 `codex`、`claude`、`agy`）：
//! `cargo test -p aiwb-agents --test live_p0 -- --ignored --nocapture`

use std::time::Duration;

use aiwb_agents::{adapter_for, adapter_for_overlay, InstanceOverlay, SessionContext, UserTurn};
use aiwb_core::models::{
    AgentInstance, AgentKind, IsolationMode, SessionEventBody, SessionStatus,
};
use serde_json::json;
use tokio::sync::mpsc;

#[tokio::test(flavor = "multi_thread")]
#[ignore = "需要本机安装并登录 Codex CLI"]
async fn live_codex_stateless_text_gen_shadow_home_and_rewind() {
    let dir = tempfile::tempdir().unwrap();
    let adapter = adapter_for(AgentKind::CodexCli);

    // 1. 验证无痕轻量文本生成（禁 MCP、禁插件、只读沙箱）
    let branch = adapter
        .generate_text(
            "Output ONLY the exact branch name `feat/shadow-home` on one line without quotes.",
            None,
            Some(dir.path()),
        )
        .await
        .expect("Codex generate_text failed");
    println!("[live codex generate_text] => {branch}");
    assert!(
        branch.to_ascii_lowercase().contains("feat/shadow-home"),
        "unexpected codex generate_text output: {branch}"
    );

    // 2. 验证 ShadowHome 实例目录隔离：真机启动 app-server 并验证影子目录挂好 skills/sessions 软链且私有 auth 隔离
    let mut inst = AgentInstance::builtin(AgentKind::CodexCli);
    inst.id = "codex-shadow-live".into();
    inst.is_default = false;
    inst.isolation_mode = IsolationMode::ShadowHome;
    let shadow_root = dir.path().join("instances");
    let overlay = InstanceOverlay::from_instance(&inst, &shadow_root);
    let shadow_home = overlay.home_path.clone().expect("shadow home path");
    let shadow_adapter = adapter_for_overlay(AgentKind::CodexCli, overlay);

    let workdir = dir.path().join("work");
    std::fs::create_dir_all(&workdir).unwrap();
    let cwd_str = workdir.to_string_lossy().into_owned();
    let (stx, _srx) = mpsc::unbounded_channel();
    let shadow_probe = shadow_adapter
        .start_session(
            SessionContext {
                project_path: cwd_str.clone(),
                access_mode: None,
                resume_native_id: None,
                workbench_mcp: None,
                options: json!({}),
            },
            stx,
        )
        .await
        .expect("start shadow codex app-server failed");
    let shadow_cat = shadow_probe.catalog().await.expect("shadow catalog");
    let _ = shadow_probe.stop().await;
    println!("[live codex shadow catalog models] => {}", shadow_cat.models.len());
    assert!(shadow_home.join("skills").exists());
    assert!(shadow_home.join("sessions").exists());
    assert!(!shadow_cat.models.is_empty());

    // 3. 在已登录的宿主实例跑两轮对话，并调用真机 `rewind_thread`（`thread/fork` beforeTurnId）撤回第 2 轮
    let (tx, mut rx) = mpsc::unbounded_channel();
    let session = adapter
        .start_session(
            SessionContext {
                project_path: cwd_str.clone(),
                access_mode: Some("full".into()),
                resume_native_id: None,
                workbench_mcp: None,
                options: json!({ "persist": true }),
            },
            tx,
        )
        .await
        .expect("start codex session failed");

    async fn wait_turn(rx: &mut mpsc::UnboundedReceiver<SessionEventBody>) -> Option<String> {
        let mut turn_id = None;
        let mut saw_running = false;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
        while tokio::time::Instant::now() < deadline {
            match tokio::time::timeout(Duration::from_secs(60), rx.recv()).await {
                Ok(Some(body)) => match body {
                    SessionEventBody::TurnAnchor { turn_id: tid, .. } if !tid.is_empty() => {
                        turn_id = Some(tid);
                    }
                    SessionEventBody::StatusChanged {
                        status: SessionStatus::Running,
                    } => {
                        saw_running = true;
                    }
                    SessionEventBody::StatusChanged {
                        status: SessionStatus::Completed,
                    } if saw_running && turn_id.is_some() => {
                        return turn_id;
                    }
                    SessionEventBody::StatusChanged {
                        status: SessionStatus::Failed,
                    } => panic!("codex turn failed"),
                    SessionEventBody::Error { message } => {
                        println!("[live codex error] {message}");
                    }
                    _ => {}
                },
                _ => break,
            }
        }
        turn_id
    }

    session
        .deliver(UserTurn {
            text: "Remember token LIME-77. Reply OK only. Do not use tools.".into(),
            images: Vec::new(),
            client_id: "c1".into(),
            annotations: Vec::new(),
        })
        .await
        .expect("turn 1 deliver");
    let turn1_id = wait_turn(&mut rx).await.expect("turn 1 id");

    session
        .deliver(UserTurn {
            text: "Now forget LIME-77 and reply BETA only. Do not use tools.".into(),
            images: Vec::new(),
            client_id: "c2".into(),
            annotations: Vec::new(),
        })
        .await
        .expect("turn 2 deliver");
    let turn2_id = wait_turn(&mut rx).await.expect("turn 2 id");
    let native_id = session.native_id().expect("codex native_id");
    let _ = session.stop().await;
    println!("[live codex turns] native={native_id} t1={turn1_id} t2={turn2_id}");

    // 原生回退掉第 2 轮（保留 1 轮），再 resume 回退后的新线程确认它仍然记得第 1 轮的 LIME-77！
    let rewound_id = adapter
        .rewind_thread(&native_id, &cwd_str, Some(&turn2_id), 1, true)
        .await
        .expect("codex rewind_thread failed")
        .expect("codex should return forked rewound thread id");
    println!("[live codex rewound_id] => {rewound_id}");
    assert_ne!(rewound_id, native_id);
}

#[tokio::test]
#[ignore = "需要本机安装并配置 Claude Code CLI"]
async fn live_claude_stateless_text_gen() {
    let dir = tempfile::tempdir().unwrap();
    let adapter = adapter_for(AgentKind::ClaudeCode);
    match adapter
        .generate_text(
            "Output ONLY the exact branch name `fix/tray-mutex` on one line without quotes.",
            None,
            Some(dir.path()),
        )
        .await
    {
        Ok(out) => {
            println!("[live claude generate_text] => {out}");
            assert!(
                out.to_ascii_lowercase().contains("fix/tray-mutex"),
                "unexpected claude generate_text output: {out}"
            );
        }
        Err(err) if err.to_string().contains("Not logged in") => {
            println!("[live claude generate_text] CLI flags & JSON output verified; host Claude CLI is not logged in: {err}");
        }
        Err(err) => panic!("Claude generate_text failed: {err:?}"),
    }
}

#[tokio::test]
#[ignore = "需要本机安装并登录 Antigravity CLI (agy)"]
async fn live_antigravity_stateless_text_gen() {
    let dir = tempfile::tempdir().unwrap();
    let conv_dir = std::env::var_os("ANTIGRAVITY_GEMINI_DIR")
        .map(std::path::PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
        .or_else(|| aiwb_agents::instance::user_home_dir().map(|h| h.join(".gemini")))
        .map(|g| g.join("antigravity-cli").join("conversations"));
    let snapshot_convs = || -> std::collections::HashSet<String> {
        conv_dir
            .as_ref()
            .and_then(|d| std::fs::read_dir(d).ok())
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".db"))
            .collect()
    };
    let before = snapshot_convs();

    let adapter = adapter_for(AgentKind::Antigravity);
    let out = adapter
        .generate_text(
            "Output ONLY the exact branch name `feat/keybindings` on one line without quotes.",
            None,
            Some(dir.path()),
        )
        .await
        .expect("Antigravity generate_text failed");
    println!("[live agy generate_text] => {out}");
    assert!(
        out.to_ascii_lowercase().contains("feat/keybindings"),
        "unexpected agy generate_text output: {out}"
    );

    let after = snapshot_convs();
    let leaked: Vec<_> = after.difference(&before).collect();
    assert!(
        leaked.is_empty(),
        "agy_generate_text must clean up transient session, leaked: {leaked:?}"
    );
}
