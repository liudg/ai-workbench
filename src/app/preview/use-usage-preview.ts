import { useEffect, useMemo } from "react";

import { seedSubscriptionUsage } from "@/features/panel/core/subscription-cache";
import { parseSubscriptionSeed } from "@/store/subscription-usage";
import type { AgentKind, AgentProfile } from "@/types";

/** `?subscription=` 给了额度时，面板顶栏显示它。 */
export function useUsagePreviewProfiles(): Partial<Record<AgentKind, AgentProfile>> {
  const seeded = useMemo(() => {
    const raw = new URLSearchParams(window.location.search).get("subscription");
    return raw ? parseSubscriptionSeed(raw) : null;
  }, []);
  useEffect(() => {
    if (seeded) seedSubscriptionUsage("claude-code", seeded);
  }, [seeded]);
  return useMemo(
    () => ({
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
    }),
    [seeded],
  );
}
