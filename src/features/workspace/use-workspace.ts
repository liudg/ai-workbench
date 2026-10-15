import { useMemo } from "react";

import { useWorkbench } from "@/store";
import { sessionFromDraft } from "@/store/draft-session";
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
  const draft = useWorkbench((s) => (selectedProjectId ? s.drafts[selectedProjectId] : undefined));
  const draftFocused = useWorkbench((s) =>
    selectedProjectId ? Boolean(s.draftFocused[selectedProjectId]) : false,
  );
  const draftSession = draftFocused && draft ? sessionFromDraft(draft) : null;
  const liveSession = sessions?.find((item) => item.id === activeSessionId) ?? null;
  const session = draftSession ?? liveSession;
  const events = useWorkbench((s) => (session ? s.events[session.id] : undefined)) ?? EMPTY_EVENTS;
  const usage = useMemo(() => accumulateSessionUsage(events), [events]);
  return { project, sessions, session, events, usage };
}
