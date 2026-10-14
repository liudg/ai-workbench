import { useMemo } from "react";

import { useWorkbench } from "@/store";
import { accumulateSessionUsage } from "@/store/session-usage";
import type { SessionEvent } from "@/types";

const EMPTY_EVENTS: SessionEvent[] = [];

export function useWorkspace() {
  const selectedProjectId = useWorkbench((s) => s.selectedProjectId);
  const project = useWorkbench((s) => s.projects.find((p) => p.id === s.selectedProjectId));
  const sessions = useWorkbench((s) => (selectedProjectId ? s.sessions[selectedProjectId] : undefined));
  const activeSessionId = useWorkbench((s) =>
    selectedProjectId ? s.activeSessionId[selectedProjectId] : undefined,
  );
  const session = sessions?.find((item) => item.id === activeSessionId);
  const events = useWorkbench((s) => (session ? s.events[session.id] : undefined)) ?? EMPTY_EVENTS;
  const usage = useMemo(() => accumulateSessionUsage(events), [events]);
  return { project, sessions, session, events, usage };
}
