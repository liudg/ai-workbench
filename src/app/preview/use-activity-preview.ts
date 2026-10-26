import type { AgentKind, AgentProfile } from "@/types";

/** 样例页里的 Codex：没有斜杠、模型这些能力，只看时间线。 */
export const ACTIVITY_PREVIEW_PROFILES: Partial<Record<AgentKind, AgentProfile>> = {
  "codex-cli": {
    kind: "codex-cli",
    display_name: "Codex",
    icon: "",
    commands: [],
    default_access: null,
    capabilities: {
      supports_slash: false,
      supports_resume: false,
      supports_questions: false,
      supports_tuning: false,
      supports_skills: false,
      changes: { turn_diff: false, per_file_patch: false, git_scopes: false },
    },
  },
};
