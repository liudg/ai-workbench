import { useEffect } from "react";

import { useWorkbench } from "@/store";

export function useUsagePreviewProfiles() {
  useEffect(() => {
    useWorkbench.setState({
      profiles: {
        "claude-code": {
          kind: "claude-code",
          display_name: "Claude Code",
          icon: "/agent-icons/claude.svg",
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
      },
    });
  }, []);
}
