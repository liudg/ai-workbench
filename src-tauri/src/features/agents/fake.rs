//! 测试用的非 Codex 适配器事件。不注册进 Agent 列表，只证明归一化变更不依赖某一种 CLI。

#[cfg(test)]
use crate::models::ChangeCapabilities;
use crate::models::{FileChange, FileStatus, SessionEventBody};

#[cfg(test)]
pub fn demo_capabilities() -> ChangeCapabilities {
    ChangeCapabilities {
        turn_diff: true,
        per_file_patch: true,
        git_scopes: false,
    }
}

pub fn demo_events(turn_id: &str) -> Vec<SessionEventBody> {
    let file = FileChange {
        path: "notes/fake.md".into(),
        status: FileStatus::Modified,
        added: 2,
        removed: 1,
        diff: "@@ -1 +1,2 @@\n-old\n+new\n+line".into(),
    };
    vec![
        SessionEventBody::FileChange {
            turn_id: turn_id.to_string(),
            path: file.path.clone(),
            status: file.status,
            added: file.added,
            removed: file.removed,
            diff: file.diff.clone(),
        },
        SessionEventBody::TurnChanges {
            turn_id: turn_id.to_string(),
            files: vec![file],
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn demo_adapter_emits_normalized_file_events() {
        let caps = demo_capabilities();
        assert!(caps.turn_diff);
        assert!(caps.per_file_patch);
        assert!(!caps.git_scopes);
        let bodies = demo_events("fake-turn");
        assert!(bodies.iter().any(|body| matches!(
            body,
            SessionEventBody::FileChange { turn_id, path, .. }
                if turn_id == "fake-turn" && path == "notes/fake.md"
        )));
        assert!(bodies.iter().any(|body| matches!(
            body,
            SessionEventBody::TurnChanges { turn_id, files }
                if turn_id == "fake-turn" && files.len() == 1
        )));
        assert!(!bodies
            .iter()
            .any(|body| matches!(body, SessionEventBody::TurnDiff { .. })));
        assert!(!bodies.iter().any(|body| matches!(
            body,
            SessionEventBody::ToolCall { name, .. } if name == "apply_patch"
        )));
    }
}
