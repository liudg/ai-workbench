import { backend } from "@/lib/ipc";
import { initialSandbox } from "@/lib/sandbox";
import { loadSessions } from "../sync";
import {
  claimDraft,
  applyDraftSend,
  applyThreadSend,
  firstSendBody,
  forgetProjectDraft,
  parkComposerText,
  projectOfDraft,
  runDraftSend,
  withCollaborationEvent,
  withGoalEvent,
  type DraftCarryState,
  type DraftSendResult,
  type FirstSendOutcome,
} from "../draft-session";
import { focusProjectDraft } from "../lazy-draft";
import { readDraftSnapshot } from "../draft-storage";
import { adoptCreatedChat, retargetEmptyDraft, retargetStandaloneDraft } from "../standalone";
import type { SessionSandbox } from "@/types";
import type { DraftSlice, PendingStart, SessionDraft, WorkbenchGet, WorkbenchSet, WorkbenchState } from "../types";

const catalogEpoch = new Map<string, number>();

function dropPending(
  pending: Record<string, PendingStart>,
  projectId: string,
): Record<string, PendingStart> {
  if (!(projectId in pending)) return pending;
  const next = { ...pending };
  delete next[projectId];
  return next;
}

async function discardQuiet(sessionId: string): Promise<boolean> {
  try {
    await backend.discardUnsentSession(sessionId);
    return true;
  } catch {
    return false;
  }
}

async function settleDraftCreate(
  set: WorkbenchSet,
  get: WorkbenchGet,
  projectId: string,
  result: DraftSendResult<FirstSendOutcome>,
  sentText: string,
  kind: "draft" | "thread",
  sandbox?: SessionSandbox | null,
): Promise<boolean> {
  if (!result.ok && result.skipped) return false;
  let dismissed = Boolean(
    get().drafts[projectId]?.cancelRequested || get().pendingStart[projectId]?.cancelRequested,
  );
  const missed = result.ok ? Boolean(result.value.messageError?.trim()) : false;
  if (dismissed && result.ok && !missed) dismissed = false;
  if (dismissed && result.ok && missed) {
    const gone = await discardQuiet(result.value.session.id);
    if (!gone) dismissed = false;
  }
  const createdProjectId =
    result.ok && result.value.session.project_id ? result.value.session.project_id : projectId;
  let list = get().sessions[createdProjectId] ?? [];
  if (result.ok && !dismissed) {
    try {
      [, list] = await loadSessions(createdProjectId);
    } catch {
      list = get().sessions[createdProjectId] ?? [];
    }
  }
  const options = { dismissed, sentText };
  const settled =
    kind === "draft"
      ? applyDraftSend(carry(get()), projectId, result, list, options)
      : applyThreadSend(carry(get()), projectId, result, list, options);
  if (settled.restore) parkComposerText(settled.restore.sessionId, settled.restore.text);
  if (!settled.patch) return false;
  const sessionId = result.ok ? result.value.session.id : null;
  const keepSession = result.ok && !dismissed;
  const created = keepSession ? result.value.project ?? null : null;
  set((s) => {
    const patch = settled.patch;
    if (!patch) return {};
    const relocated =
      keepSession && result.ok && result.value.session.project_id !== projectId
        ? adoptCreatedChat(patch, projectId, result.value.session)
        : patch;
    const projects =
      created && !s.projects.some((item) => item.id === created.id)
        ? [...s.projects, created]
        : s.projects;
    const pendingStart = dropPending(s.pendingStart, projectId);
    const revealed =
      missed && keepSession && sessionId
        ? {
            events: {
              ...relocated.events,
              [sessionId]: relocated.events[sessionId] ?? [],
            },
            eventsReady: { ...s.eventsReady, [sessionId]: true },
          }
        : null;
    if (!(keepSession && sandbox && sessionId)) {
      return { ...relocated, ...revealed, projects, pendingStart, screen: "workspace" as const };
    }
    return {
      ...relocated,
      ...revealed,
      projects,
      pendingStart,
      screen: "workspace" as const,
      sandboxes: { ...relocated.sandboxes, [sessionId]: sandbox },
      accessMode: {
        ...relocated.accessMode,
        [sessionId]: sandbox.profileId ? "ask" : sandbox.mode,
      },
    };
  });
  return settled.sent;
}

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
    pendingStart: {},

    cancelDraftSend(projectId) {
      set((s) => {
        const draft = s.drafts[projectId];
        const pending = s.pendingStart[projectId];
        const creating = draft?.phase === "creating";
        if (!creating && !pending) return {};
        if (creating && draft?.cancelRequested && (!pending || pending.cancelRequested)) return {};
        if (!creating && pending?.cancelRequested) return {};
        return {
          drafts:
            creating && draft
              ? { ...s.drafts, [projectId]: { ...draft, cancelRequested: true } }
              : s.drafts,
          pendingStart: pending
            ? { ...s.pendingStart, [projectId]: { ...pending, cancelRequested: true } }
            : s.pendingStart,
        };
      });
    },
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
      set((s) => ({
        ...focusProjectDraft(s, projectId, agent, sandbox),
        selectedProjectId: projectId,
        screen: "workspace" as const,
        lastError: null,
      }));
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
      const existing = get().drafts[projectId];
      const claimed = claimDraft(existing);
      if (!claimed) return false;
      const body = firstSendBody(claimed, { text, images, annotations });
      const result = await runDraftSend(projectId, () => {
        const at = Date.now();
        set((s) => {
          const current = s.drafts[projectId];
          if (!current || current.phase === "creating") return {};
          return {
            drafts: {
              ...s.drafts,
              [projectId]: {
                ...current,
                phase: "creating",
                creatingSince: at,
                cancelRequested: false,
              },
            },
            pendingStart: {
              ...s.pendingStart,
              [projectId]: { agent: current.agent, title: text, at },
            },
            lastError: null,
          };
        });
        return backend.createSessionAndSend(body);
      });
      return settleDraftCreate(set, get, projectId, result, text, "draft");
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
      const result = await runDraftSend(projectId, () => {
        const at = Date.now();
        set((s) => {
          const current = s.drafts[projectId];
          const drafts =
            current && current.phase !== "creating"
              ? {
                  ...s.drafts,
                  [projectId]: {
                    ...current,
                    phase: "creating" as const,
                    creatingSince: at,
                    cancelRequested: false,
                  },
                }
              : s.drafts;
          return {
            drafts,
            pendingStart: {
              ...s.pendingStart,
              [projectId]: { agent, title: text, at },
            },
            lastError: null,
          };
        });
        return backend.createSessionAndSend(body);
      });
      const sent = await settleDraftCreate(set, get, projectId, result, text, "thread", sandbox);
      const selected = get().selectedProjectId ?? projectId;
      return sent ? (get().activeSessionId[selected] ?? null) : null;
    },

    retargetDraft(fromProjectId, targetProjectId) {
      const next = retargetEmptyDraft(carry(get()), fromProjectId, targetProjectId);
      if (!next) return;
      set({ ...next, screen: "workspace" });
    },

    moveStandaloneDraft(projectId) {
      const next = retargetStandaloneDraft(carry(get()), projectId);
      if (!next) return;
      set({ ...next, screen: "workspace" });
    },
  };
}

export function dropProjectDraft(projectId: string): (state: DraftCarryState) => DraftCarryState {
  return (state) => forgetProjectDraft(state, projectId);
}
