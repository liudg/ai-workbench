import { useEffect } from "react";

import { useWorkbench } from "@/store";

export function useActivityPreviewProfiles() {
  useEffect(() => {
    useWorkbench.setState({
      profiles: {
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
      },
    });
  }, []);
}
