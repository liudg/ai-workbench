import { useMemo } from "react";

import { useWorkbench } from "@/store";
import { isDraftId } from "@/store/draft-session";
import { accumulateSessionUsage } from "@/store/session-usage";
import {
  isStandaloneDraft,
  standaloneDraftProject,
  STANDALONE_DRAFT_ID,
  STANDALONE_DRAFT_TITLE,
} from "@/store/standalone";
import type { SessionEvent } from "@/types";
import { visibleWorkspaceSession } from "./workspace-session";

const EMPTY_EVENTS: SessionEvent[] = [];

export function useWorkspace() {
  const selectedProjectId = useWorkbench((s) => s.selectedProjectId);
  const storedProject = useWorkbench((s) => s.projects.find((p) => p.id === s.selectedProjectId));
  const sessions = useWorkbench((s) => (selectedProjectId ? s.sessions[selectedProjectId] : undefined));
  const activeSessionId = useWorkbench((s) =>
    selectedProjectId ? s.activeSessionId[selectedProjectId] : undefined,
  );
  const draft = useWorkbench((s) => (selectedProjectId ? s.drafts[selectedProjectId] : undefined));
  const draftFocused = useWorkbench((s) =>
    selectedProjectId ? Boolean(s.draftFocused[selectedProjectId]) : false,
  );
  const draftAgent = draft?.agent;
  const project = useMemo(() => {
    if (storedProject) return storedProject;
    if (!isStandaloneDraft(selectedProjectId) || !draftAgent) return undefined;
    return standaloneDraftProject({
      projectId: STANDALONE_DRAFT_ID,
      agent: draftAgent,
      text: "",
      sandbox: null,
      tuning: null,
      collaboration: "default",
      goal: null,
      goalStatus: null,
      phase: "idle",
    });
  }, [draftAgent, selectedProjectId, storedProject]);
  const picked = visibleWorkspaceSession({
    sessions,
    activeSessionId,
    draft,
    draftFocused,
  });
  const session =
    picked && isDraftId(picked.id) && isStandaloneDraft(picked.project_id)
      ? { ...picked, title: STANDALONE_DRAFT_TITLE }
      : picked;
  const events = useWorkbench((s) => (session ? s.events[session.id] : undefined)) ?? EMPTY_EVENTS;
  const usage = useMemo(() => accumulateSessionUsage(events), [events]);
  return { project, sessions, session, events, usage };
}
