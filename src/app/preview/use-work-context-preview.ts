import { useLayoutEffect } from "react";

import { persistedAgentKind } from "@/lib/agents";
import { useWorkbench } from "@/store";
import { emptyProjectDraftUpdate, landOnEmptyProjectDraft } from "@/store/lazy-draft";
import { keepSelectedProjectId, STANDALONE_DRAFT_ID } from "@/store/standalone";
import type { AgentInstallation, AgentKind, AgentProfile, Project, Session, SessionEvent } from "@/types";

const APP_ID = "preview-app";
const NOTES_ID = "preview-notes";

function profile(kind: AgentKind, name: string): AgentProfile {
  return {
    kind,
    display_name: name,
    icon: null,
    commands: [],
    default_access: null,
    capabilities: {
      supports_slash: false,
      supports_resume: false,
      supports_questions: false,
      supports_tuning: false,
      supports_skills: false,
      supports_rename: true,
      supports_fork: false,
      supports_archive: false,
      supports_delete: false,
      changes: { turn_diff: false, per_file_patch: false, git_scopes: false },
    },
  };
}

function installation(kind: AgentKind, name: string): AgentInstallation {
  return {
    kind,
    display_name: name,
    installed: true,
    version: null,
    latest_version: null,
    update_available: false,
    update_via: null,
    detail: null,
    session_linked: true,
  };
}

function project(id: string, name: string): Project {
  return {
    id,
    name,
    path: `C:/work/${id}`,
    default_agent: "codex-cli",
    created_at: 1,
    updated_at: 1,
  };
}

function sentSession(): Session {
  return {
    id: "codex-cli:sent",
    project_id: APP_ID,
    agent: "codex-cli",
    native_id: "sent",
    title: "看一下项目结构",
    status: "completed",
    created_at: 1,
    updated_at: 2,
  };
}

function emptySession(): Session {
  return {
    id: "codex-cli:empty",
    project_id: APP_ID,
    agent: "codex-cli",
    native_id: "empty",
    title: "未发送",
    status: "completed",
    created_at: 1,
    updated_at: 2,
  };
}

function userMessage(sessionId: string): SessionEvent {
  return {
    id: "user-1",
    session_id: sessionId,
    seq: 1,
    ts: 1,
    kind: "user-message",
    text: "看一下项目结构",
  };
}

export function useWorkContextPreview() {
  const scene = new URLSearchParams(window.location.search).get("scene") ?? "fresh";

  useLayoutEffect(() => {
    const installations = [
      installation("codex-cli", "Codex CLI"),
      installation("claude-code", "Claude Code"),
    ];
    const projects = [project(APP_ID, "工作台"), project(NOTES_ID, "笔记")];
    useWorkbench.setState({
      ready: true,
      screen: "workspace",
      lastError: null,
      projects,
      installations,
      installationsLoading: false,
      profiles: {
        "codex-cli": profile("codex-cli", "Codex CLI"),
        "claude-code": profile("claude-code", "Claude Code"),
      },
      sessions: { [APP_ID]: [], [NOTES_ID]: [] },
      selectedProjectId: null,
      activeSessionId: {},
      drafts: {},
      draftFocused: {},
      events: {},
      eventsReady: {},
      preferredAgent: null,
    });
    if (scene === "none") return;
    const agent = persistedAgentKind(installations, null);
    if (scene === "sent") {
      const session = sentSession();
      useWorkbench.setState({
        selectedProjectId: APP_ID,
        sessions: { [APP_ID]: [session], [NOTES_ID]: [] },
        activeSessionId: { [APP_ID]: session.id },
        events: { [session.id]: [userMessage(session.id)] },
        eventsReady: { [session.id]: true },
      });
      return;
    }
    if (scene === "empty") {
      const session = emptySession();
      useWorkbench.setState({
        selectedProjectId: APP_ID,
        sessions: { [APP_ID]: [session], [NOTES_ID]: [] },
        activeSessionId: { [APP_ID]: session.id },
        events: { [session.id]: [] },
        eventsReady: { [session.id]: true },
      });
      return;
    }
    if (scene === "choose") {
      const session = sentSession();
      useWorkbench.setState({
        selectedProjectId: APP_ID,
        sessions: { [APP_ID]: [session], [NOTES_ID]: [] },
        activeSessionId: {},
        events: { [session.id]: [userMessage(session.id)] },
        eventsReady: { [session.id]: true },
      });
      return;
    }
    if (scene === "cleared") {
      useWorkbench.setState({
        selectedProjectId: APP_ID,
        sessions: { [APP_ID]: [], [NOTES_ID]: [] },
        activeSessionId: {},
      });
      const landed = landOnEmptyProjectDraft(useWorkbench.getState(), APP_ID);
      if (landed) useWorkbench.setState(emptyProjectDraftUpdate(landed));
      return;
    }
    const selected = keepSelectedProjectId({
      projects,
      current: null,
      standaloneDraftFocused: false,
    });
    if (selected === STANDALONE_DRAFT_ID && agent) {
      useWorkbench.getState().openDraft(STANDALONE_DRAFT_ID, agent);
    }
    if (scene === "project" && agent) {
      useWorkbench.getState().openDraft(APP_ID, agent);
    }
  }, [scene]);
}
