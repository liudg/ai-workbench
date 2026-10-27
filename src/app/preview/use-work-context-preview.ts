import { useLayoutEffect } from "react";

import { seedAgents } from "@/features/agents";
import type { Project } from "@/features/projects";
import { startPreview, TOPIC_PROJECTS, TOPIC_TASKS } from "@/lib/daemon";
import { openNewSession } from "@/shared/shell/navigation";
import type { AgentInstallation, AgentKind, AgentProfile } from "@/types";

const APP_ID = "work-context-app";
const NOTES_ID = "work-context-notes";

function profile(kind: AgentKind, name: string): AgentProfile {
  return {
    kind,
    display_name: name,
    icon: null,
    commands: [],
    default_access: null,
    capabilities: {
      supports_slash: true,
      supports_resume: true,
      supports_questions: true,
      supports_tuning: true,
      supports_skills: false,
      supports_images: true,
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
  return { id, name, path: `/work/${id}`, folders: [`/work/${id}`], pinned: false, createdAt: 1, updatedAt: 1 };
}

/** `scene=fresh` 独立聊天的新会话，`project` 项目里的新会话，`none` 什么都没选。 */
export function useWorkContextPreview() {
  const scene = new URLSearchParams(window.location.search).get("scene") ?? "fresh";

  useLayoutEffect(() => {
    startPreview({
      [TOPIC_PROJECTS]: [project(APP_ID, "工作台"), project(NOTES_ID, "笔记")],
      [TOPIC_TASKS]: [],
    });
    seedAgents(
      { "codex-cli": profile("codex-cli", "Codex CLI"), "claude-code": profile("claude-code", "Claude Code") },
      [installation("codex-cli", "Codex CLI"), installation("claude-code", "Claude Code")],
    );
    if (scene === "fresh") openNewSession(null);
    if (scene === "project") openNewSession(APP_ID);
  }, [scene]);
}
