import { useEffect, useState } from "react";

import type { AgentKind, AgentProfile } from "@/types";
import { agentProfiles } from "./task-backend";

type Profiles = Partial<Record<AgentKind, AgentProfile>>;

/** 各 Agent 的能力、斜杠命令、显示名和图标。daemon 给一次就够。 */
export function useAgentProfiles(): Profiles {
  const [profiles, setProfiles] = useState<Profiles>({});
  useEffect(() => {
    let cancelled = false;
    void agentProfiles()
      .then((list) => {
        if (cancelled) return;
        setProfiles(Object.fromEntries(list.map((profile) => [profile.kind, profile])));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return profiles;
}
