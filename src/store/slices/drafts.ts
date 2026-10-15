import { backend } from "@/lib/ipc";
import { initialSandbox } from "@/lib/sandbox";
import { loadSessions } from "../sync";
import {
  claimDraft,
  draftId,
  applyDraftSend,
  firstSendBody,
  forgetProjectDraft,
  openProjectDraft,
  projectOfDraft,
  runDraftSend,
  withCollaborationEvent,
  withGoalEvent,
  type DraftCarryState,
} from "../draft-session";
import { readDraftSnapshot } from "../draft-storage";
import type { DraftSlice, SessionDraft, WorkbenchGet, WorkbenchSet, WorkbenchState } from "../types";

const catalogEpoch = new Map<string, number>();

function carry(state: {
  drafts: DraftSlice["drafts"];
  draftFocused: DraftSlice["draftFocused"];
  activeSessionId: Record<string, string>;
  sessions: DraftCarryState["sessions"];
  attachments: DraftCarryState["attachments"];
  textSnippets: DraftCarryState["textSnippets"];
  sandboxes: DraftCarryState["sandboxes"];
  tuning: DraftCarryState["tuning"];
  accessMode: DraftCarryState["accessMode"];
  events: DraftCarryState["events"];
  catalogs: DraftCarryState["catalogs"];
  catalogNotices: DraftCarryState["catalogNotices"];
  lastSandboxByAgent: DraftCarryState["lastSandboxByAgent"];
  selectedProjectId: string | null;
  preferredAgent: DraftCarryState["preferredAgent"];
}): DraftCarryState {
  return state;
}

function patchDraft(
  drafts: Record<string, SessionDraft>,
  projectId: string,
  recipe: (draft: SessionDraft) => SessionDraft,
): Record<string, SessionDraft> | null {
  const current = drafts[projectId];
  if (!current) return null;
  return { ...drafts, [projectId]: recipe(current) };
}

export function createDraftSlice(
  set: WorkbenchSet,
  get: WorkbenchGet,
): DraftSlice &
  Pick<WorkbenchState, "attachments" | "textSnippets" | "sandboxes" | "tuning" | "events"> {
  const restored = readDraftSnapshot();
  return {
    drafts: restored.drafts,
    draftFocused: restored.draftFocused,
    attachments: restored.attachments,
    textSnippets: restored.textSnippets,
    sandboxes: restored.sandboxes,
    tuning: restored.tuning,
    events: restored.events,

    openDraft(projectId, agent) {
      const sandbox = initialSandbox(
        get().lastSandboxByAgent[agent],
        get().profiles[agent]?.default_access,
      );
      set((s) => {
        const existing = s.drafts[projectId];
        const next = openProjectDraft(existing, projectId, agent, sandbox);
        const id = draftId(projectId);
        const agentChanged = Boolean(existing && existing.agent !== next.agent);
        const activeSessionId = { ...s.activeSessionId };
        delete activeSessionId[projectId];
        const catalogs = { ...s.catalogs };
        const catalogNotices = { ...s.catalogNotices };
        const tuning = { ...s.tuning };
        const sandboxes = { ...s.sandboxes };
        const events = { ...s.events };
        if (!existing || agentChanged) {
          delete catalogs[id];
          delete catalogNotices[id];
          delete tuning[id];
          delete events[id];
          if (next.sandbox) sandboxes[id] = next.sandbox;
          else delete sandboxes[id];
        } else if (next.sandbox && !sandboxes[id]) {
          sandboxes[id] = next.sandbox;
        }
        return {
          selectedProjectId: projectId,
          preferredAgent: agent,
          screen: "workspace",
          drafts: { ...s.drafts, [projectId]: next },
          draftFocused: { ...s.draftFocused, [projectId]: true },
          activeSessionId,
          catalogs,
          catalogNotices,
          tuning,
          sandboxes,
          events,
          lastError: null,
        };
      });
    },

    rememberDraftText(projectId, text) {
      set((s) => {
        const next = patchDraft(s.drafts, projectId, (draft) =>
          draft.text === text ? draft : { ...draft, text },
        );
        if (!next || next[projectId] === s.drafts[projectId]) return {};
        return { drafts: next };
      });
    },

    setDraftSandbox(sessionId, sandbox) {
      const projectId = projectOfDraft(sessionId);
      if (!projectId) return;
      const mode = sandbox.profileId ? "ask" : sandbox.mode;
      set((s) => {
        const draft = s.drafts[projectId];
        return {
          accessMode: { ...s.accessMode, [sessionId]: mode },
          sandboxes: { ...s.sandboxes, [sessionId]: sandbox },
          lastSandboxByAgent: draft
            ? { ...s.lastSandboxByAgent, [draft.agent]: sandbox }
            : s.lastSandboxByAgent,
          drafts: draft
            ? { ...s.drafts, [projectId]: { ...draft, sandbox } }
            : s.drafts,
        };
      });
    },

    setDraftTuning(sessionId, model, effort, serviceTier) {
      const projectId = projectOfDraft(sessionId);
      if (!projectId) return;
      set((s) => {
        const previous = s.tuning[sessionId];
        const nextTier = serviceTier === undefined ? previous?.serviceTier : serviceTier;
        const tuning = {
          model,
          effort,
          ...(nextTier !== undefined ? { serviceTier: nextTier } : {}),
        };
        const draft = s.drafts[projectId];
        return {
          tuning: { ...s.tuning, [sessionId]: tuning },
          drafts: draft ? { ...s.drafts, [projectId]: { ...draft, tuning } } : s.drafts,
        };
      });
    },

    setDraftCollaboration(sessionId, mode) {
      const projectId = projectOfDraft(sessionId);
      if (!projectId) return;
      set((s) => {
        const draft = s.drafts[projectId];
        if (!draft || draft.phase === "creating") return {};
        const collaboration = mode === "plan" ? "plan" : "default";
        return {
          drafts: { ...s.drafts, [projectId]: { ...draft, collaboration } },
          events: {
            ...s.events,
            [sessionId]: withCollaborationEvent(s.events[sessionId] ?? [], sessionId, collaboration),
          },
        };
      });
    },

    setDraftGoal(sessionId, objective) {
      const projectId = projectOfDraft(sessionId);
      if (!projectId) return;
      const goal = objective.trim();
      if (!goal) return;
      set((s) => {
        const draft = s.drafts[projectId];
        if (!draft) return {};
        return {
          drafts: {
            ...s.drafts,
            [projectId]: { ...draft, goal, goalStatus: draft.goalStatus ?? "active" },
          },
          events: {
            ...s.events,
            [sessionId]: withGoalEvent(
              s.events[sessionId] ?? [],
              sessionId,
              goal,
              draft.goalStatus ?? "active",
            ),
          },
        };
      });
    },

    clearDraftGoal(sessionId) {
      const projectId = projectOfDraft(sessionId);
      if (!projectId) return;
      set((s) => {
        const draft = s.drafts[projectId];
        if (!draft) return {};
        return {
          drafts: { ...s.drafts, [projectId]: { ...draft, goal: null, goalStatus: null } },
          events: {
            ...s.events,
            [sessionId]: withGoalEvent(s.events[sessionId] ?? [], sessionId, "", "active"),
          },
        };
      });
    },

    setDraftGoalStatus(sessionId, status) {
      const projectId = projectOfDraft(sessionId);
      if (!projectId) return;
      set((s) => {
        const draft = s.drafts[projectId];
        if (!draft?.goal) return {};
        return {
          drafts: { ...s.drafts, [projectId]: { ...draft, goalStatus: status } },
          events: {
            ...s.events,
            [sessionId]: withGoalEvent(s.events[sessionId] ?? [], sessionId, draft.goal, status),
          },
        };
      });
    },

    async loadDraftCatalog(sessionId) {
      const projectId = projectOfDraft(sessionId);
      if (!projectId) return;
      const agent = get().drafts[projectId]?.agent;
      if (!agent) return;
      const epoch = (catalogEpoch.get(sessionId) ?? 0) + 1;
      catalogEpoch.set(sessionId, epoch);
      const current = () =>
        catalogEpoch.get(sessionId) === epoch && get().drafts[projectId]?.agent === agent;
      try {
        const refresh = await backend.cachedAgentCatalog(agent);
        if (!current()) return;
        if (refresh.catalog.agent && refresh.catalog.agent !== agent) return;
        set((s) => {
          const catalogNotices = { ...s.catalogNotices };
          delete catalogNotices[sessionId];
          return {
            catalogs: { ...s.catalogs, [sessionId]: refresh.catalog },
            catalogNotices,
          };
        });
      } catch {
        if (!current()) return;
        set((s) => {
          const catalogs = { ...s.catalogs };
          const catalogNotices = { ...s.catalogNotices };
          delete catalogs[sessionId];
          delete catalogNotices[sessionId];
          return { catalogs, catalogNotices };
        });
      }
    },

    async commitDraftMessage(sessionId, text, images, annotations) {
      const projectId = projectOfDraft(sessionId);
      if (!projectId) return false;
      const claimed = claimDraft(get().drafts[projectId]);
      if (!claimed) return false;
      const body = firstSendBody(claimed, { text, images, annotations });
      const result = await runDraftSend(projectId, async () => {
        set((s) => ({
          drafts: s.drafts[projectId]
            ? { ...s.drafts, [projectId]: claimed }
            : s.drafts,
          lastError: null,
        }));
        return backend.createSessionAndSend(body);
      });
      let list = get().sessions[projectId] ?? [];
      if (result.ok) {
        try {
          [, list] = await loadSessions(projectId);
        } catch {
          list = get().sessions[projectId] ?? [];
        }
      }
      const settled = applyDraftSend(carry(get()), projectId, result, list);
      if (!settled.patch) return false;
      set(settled.patch);
      return settled.sent;
    },

    async sendNewThread(projectId, agent, text) {
      const sandbox = initialSandbox(
        get().lastSandboxByAgent[agent],
        get().profiles[agent]?.default_access,
      );
      const body = firstSendBody(
        {
          projectId,
          agent,
          text: "",
          sandbox,
          tuning: null,
          collaboration: "default",
          goal: null,
          goalStatus: null,
          phase: "idle",
        },
        { text },
      );
      const result = await runDraftSend(projectId, () => backend.createSessionAndSend(body));
      if (!result.ok) {
        if (!result.skipped) set({ lastError: result.error });
        return null;
      }
      const session = result.value;
      let list = get().sessions[projectId] ?? [];
      try {
        [, list] = await loadSessions(projectId);
      } catch {
        list = get().sessions[projectId] ?? [];
      }
      set((s) => ({
        selectedProjectId: projectId,
        preferredAgent: agent,
        screen: "workspace",
        draftFocused: { ...s.draftFocused, [projectId]: false },
        activeSessionId: { ...s.activeSessionId, [projectId]: session.id },
        sessions: {
          ...s.sessions,
          [projectId]: list.some((item) => item.id === session.id) ? list : [session, ...list],
        },
        sandboxes: sandbox ? { ...s.sandboxes, [session.id]: sandbox } : s.sandboxes,
        accessMode: sandbox
          ? {
              ...s.accessMode,
              [session.id]: sandbox.profileId ? "ask" : sandbox.mode,
            }
          : s.accessMode,
        lastError: null,
      }));
      return session.id;
    },
  };
}

export function dropProjectDraft(projectId: string): (state: DraftCarryState) => DraftCarryState {
  return (state) => forgetProjectDraft(state, projectId);
}
