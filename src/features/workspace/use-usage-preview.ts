import { useEffect } from "react";

import { seedSubscriptionUsage } from "@/features/panel/core/subscription-cache";
import { useWorkbench } from "@/store";
import { parseSubscriptionSeed } from "@/store/subscription-usage";

export function useUsagePreviewProfiles() {
  useEffect(() => {
    const raw = new URLSearchParams(window.location.search).get("subscription");
    const seeded = raw ? parseSubscriptionSeed(raw) : null;
    if (seeded) seedSubscriptionUsage("claude-code", seeded);
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
            ...(seeded ? { supports_subscription_usage: true } : {}),
          },
        },
      },
    });
  }, []);
}
