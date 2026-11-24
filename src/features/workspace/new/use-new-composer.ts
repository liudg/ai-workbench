// 还没建好的新会话的作曲栏：Agent / 实例、模型、权限、计划、目标、工作树都先记在草稿里，
// 第一条消息发出时一起交给 daemon 建任务，建好就跳到这个会话。

import { useEffect, useMemo, useState } from "react";

import {
  agentsApi,
  useCatalogProbes,
  type SelectableInstance,
} from "@/features/agents";
import type { AgentOption, ComposerHost } from "@/features/chat/headless";
import { usePanelStore } from "@/features/panel/headless";
import { projectsApi, type Project } from "@/features/projects";
import { tasksApi } from "@/features/tasks";
import { profileForSessionAgent } from "@/shared/agent/identity";
import { showError } from "@/shared/shell/error-banner";
import { openNewSession, openTask, type ProjectScope } from "@/shared/shell/navigation";
import {
  defaultInstanceId,
  effectiveInstanceId,
  nonDefaultInstanceId,
  type AgentKind,
  type AgentProfile,
  type PermissionMenu,
  type SessionTuning,
} from "@/types";
import { filterPaths } from "../session/api";
import {
  composerDraftHostActions,
  moveDraft,
  patchDraft,
  readDraft,
  selectableToAgentOption,
  type ComposerDraft,
} from "../session/composer-drafts";
import { findCatalogProbe, matchingInstanceCatalog } from "@/lib/agents";
import { initialSandbox } from "@/lib/sandbox";
import {
  draftSelectionForKey,
  rememberAgent,
  rememberDraftSelection,
  rememberSandbox,
  rememberTuning,
  stickySandbox,
  stickySelection,
  stickyTuning,
  type StickyAgentSelection,
} from "./sticky";

const STANDALONE = "chat";
const NO_QUEUE: never[] = [];
/** 没有上次的目录，现探也没探到。 */
const NO_CATALOG = "暂无模型列表，使用 Agent 默认模型";

export function newSessionKey(projectId: ProjectScope): string {
  return `new:${projectId ?? STANDALONE}`;
}

/** 多实例草稿选择：优先本页显式切换的实例 -> 草稿 Agent -> Sticky 实例 -> 首个可用实例。 */
export function draftSelection(
  key: string,
  draft: ComposerDraft,
  selectable: readonly SelectableInstance[] | null,
): StickyAgentSelection | null {
  const matchExact = (agent: AgentKind, instanceId?: string | null): StickyAgentSelection | null => {
    const targetId = effectiveInstanceId(agent, instanceId);
    if (selectable === null) return { agent, instanceId: targetId };
    const hit = selectable.find((item) => item.kind === agent && item.instanceId === targetId);
    return hit ? { agent: hit.kind, instanceId: hit.instanceId } : null;
  };

  const matchKind = (agent: AgentKind): StickyAgentSelection | null => {
    if (selectable === null) return { agent, instanceId: defaultInstanceId(agent) };
    const hit = selectable.find((item) => item.kind === agent);
    return hit ? { agent: hit.kind, instanceId: hit.instanceId } : null;
  };

  const perKey = draftSelectionForKey(key);
  if (perKey && (!draft.agent || draft.agent === perKey.agent)) {
    const hit = matchExact(perKey.agent, perKey.instanceId);
    if (hit) return hit;
  }

  const sticky = stickySelection();
  if (draft.agent) {
    if (sticky && sticky.agent === draft.agent) {
      const hit = matchExact(sticky.agent, sticky.instanceId);
      if (hit) return hit;
    }
    const byKind = matchKind(draft.agent);
    if (byKind) return byKind;
  }

  if (sticky) {
    const hit = matchExact(sticky.agent, sticky.instanceId) ?? matchKind(sticky.agent);
    if (hit) return hit;
  }

  const first = selectable?.[0];
  return first ? { agent: first.kind, instanceId: first.instanceId } : null;
}

function initialAgentState(scope: string, agent: AgentKind | null, instanceId?: string | null) {
  return {
    scope,
    catalog: agent ? agentsApi.peekCatalog(agent, instanceId) : undefined,
    missing: false,
    permissionMenu: null as PermissionMenu | null,
  };
}

function useAgentCatalog(
  agent: AgentKind | null,
  projectId: ProjectScope,
  instanceId?: string | null,
) {
  const effectiveId = agent ? effectiveInstanceId(agent, instanceId) : "";
  const scope = `${effectiveId}\0${projectId ?? ""}`;
  const probes = useCatalogProbes();
  const probeStatus = useMemo(
    () => (agent ? findCatalogProbe(probes, agent, effectiveId)?.status : undefined),
    [agent, effectiveId, probes],
  );

  const [state, setState] = useState(() => initialAgentState(scope, agent, instanceId));
  useEffect(() => {
    const base = initialAgentState(scope, agent, instanceId);
    setState(base);
    if (!agent) return;
    let cancelled = false;
    const patch = (next: Partial<typeof base>) =>
      setState((prev) => (prev.scope === scope ? { ...prev, ...next } : { ...base, ...next }));
    const show = (next: NonNullable<typeof base.catalog>) => {
      if (cancelled) return;
      const valid = matchingInstanceCatalog(next, agent, effectiveId);
      if (!valid) return;
      patch({ catalog: valid, missing: false });
    };
    const load =
      probeStatus === "probing" || probeStatus === "failed"
        ? agentsApi.cachedCatalog(agent, instanceId).then((cached) => {
            const valid = matchingInstanceCatalog(cached, agent, effectiveId);
            if (valid) show(valid);
            else if (!cancelled && probeStatus === "failed") {
              patch({ catalog: undefined, missing: true });
            }
          })
        : agentsApi.loadCatalog(agent, projectId, show, instanceId);
    void load.catch(() => {
      if (!cancelled && !base.catalog) patch({ catalog: undefined, missing: true });
    });
    void agentsApi.draftPermissionMenu(agent, instanceId).then(
      (menu) => {
        if (!cancelled) patch({ permissionMenu: menu });
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [agent, effectiveId, instanceId, projectId, scope, probeStatus]);
  const active = state.scope === scope ? state : initialAgentState(scope, agent, instanceId);
  return {
    catalog: active.catalog,
    permissionMenu: active.permissionMenu,
    notice: active.missing ? NO_CATALOG : null,
  };
}

function useHasCommit(projectId: ProjectScope) {
  const [hasCommit, setHasCommit] = useState(false);
  useEffect(() => {
    setHasCommit(false);
    if (!projectId) return;
    let cancelled = false;
    void projectsApi.hasCommit({ projectId }).then(
      (value) => {
        if (!cancelled) setHasCommit(value);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [projectId]);
  return hasCommit;
}

export function useNewComposer({
  projectId,
  project,
  projects,
  agent,
  instanceId,
  selectableInstances = null,
  profiles,
  draft,
}: {
  projectId: ProjectScope;
  project: Project | undefined;
  projects: Project[];
  agent: AgentKind;
  instanceId?: string;
  selectableInstances?: SelectableInstance[] | null;
  profiles: Partial<Record<string, AgentProfile>>;
  draft: ComposerDraft;
}): ComposerHost {
  const key = newSessionKey(projectId);
  const effectiveId = effectiveInstanceId(agent, instanceId);
  const [creating, setCreating] = useState(false);
  const { catalog, permissionMenu, notice } = useAgentCatalog(agent, projectId, effectiveId);
  const hasCommit = useHasCommit(projectId);
  const profile = profileForSessionAgent(agent, profiles, effectiveId);
  const tuning = draft.tuning ?? stickyTuning(agent, effectiveId) ?? undefined;
  const sandbox =
    draft.sandbox ?? initialSandbox(stickySandbox(agent, effectiveId), profile?.default_access);

  return useMemo<ComposerHost>(() => {
    const patch = (next: Partial<ComposerDraft>) => patchDraft(key, next);
    const retarget = (target: ProjectScope) => {
      // 起点分支是这个项目的，换项目就不带过去。
      const targetKey = newSessionKey(target);
      rememberDraftSelection(targetKey, { agent, instanceId: effectiveId });
      rememberDraftSelection(key, null);
      moveDraft(key, targetKey, { ...readDraft(key), worktreeBase: null, carryChanges: false });
      openNewSession(target);
    };
    const options: AgentOption[] | null =
      selectableInstances?.map((item) => selectableToAgentOption(item, profiles)) ?? null;

    return {
      ...composerDraftHostActions(key),
      draft: true,
      inputLocked: creating,
      initialText: readDraft(key).text,
      initialFileRefs: readDraft(key).fileRefs ?? [],
      catalog,
      catalogNotice: notice,
      profile,
      tuning,
      sandbox,
      permissionMenu,
      projectPath: project?.path ?? "",
      files: draft.files,
      snippets: draft.snippets,
      queue: NO_QUEUE,
      followUpQueueMode: draft.followUpQueueMode ?? "queue",
      git: project ? { projectId: project.id, projectName: project.name } : null,
      workContext: {
        label: project?.name ?? "聊天",
        projects: projects.map((item) => ({ id: item.id, name: item.name })),
        selectedId: projectId ?? STANDALONE,
        standaloneId: STANDALONE,
        canRetarget: !creating,
        onPickProject: (id) => retarget(id),
        onPickStandalone: () => retarget(null),
      },
      worktree: {
        showToggle: Boolean(projectId) && hasCommit,
        pressed: Boolean(draft.worktree),
        onToggle: () => patch({ worktree: !draft.worktree }),
        liveLabel: "",
        liveTitle: "",
        start: {
          base: draft.worktreeBase ?? null,
          carry: Boolean(draft.carryChanges),
          onPick: (worktreeBase, carryChanges) => patch({ worktreeBase, carryChanges }),
        },
      },
      agentChoice: {
        options,
        selected: agent,
        selectedInstanceId: effectiveId,
        switcher: {
          blocked: null,
          loadModels: (next, show, nextInstanceId) =>
            agentsApi.loadCatalog(next, projectId, (found) => show(found.models), nextInstanceId),
          onPick: (next, model, nextInstanceId) => {
            const nextKey = effectiveInstanceId(next, nextInstanceId);
            const picked: SessionTuning = { model: model.id, effort: model.default_effort };
            rememberAgent(next, nextKey);
            rememberDraftSelection(key, { agent: next, instanceId: nextKey });
            rememberTuning(next, picked, nextKey);
            // 权限是上一个实例的，换了就不带过去。
            patch({ agent: next, tuning: picked, sandbox: null });
          },
          onPickAgentOnly: (next, nextInstanceId) => {
            const nextKey = effectiveInstanceId(next, nextInstanceId);
            rememberAgent(next, nextKey);
            rememberDraftSelection(key, { agent: next, instanceId: nextKey });
            patch({ agent: next, tuning: null, sandbox: null });
          },
        },
      },

      send: async (text, images) => {
        setCreating(true);
        try {
          const current = readDraft(key);
          const nonDefaultId = nonDefaultInstanceId(agent, effectiveId);
          const created = await tasksApi.createTask({
            projectId,
            agent,
            ...(nonDefaultId ? { instanceId: nonDefaultId } : {}),
            prompt: text,
            images,
            worktree: Boolean(projectId) && Boolean(current.worktree),
            ...(projectId && current.worktree
              ? { worktreeBase: current.worktreeBase ?? undefined, carryChanges: Boolean(current.carryChanges) }
              : {}),
            options: {
              model: tuning?.model,
              effort: tuning?.model ? tuning.effort : undefined,
              serviceTier: tuning?.serviceTier === undefined ? undefined : (tuning.serviceTier ?? ""),
              access: sandbox ? { ...sandbox } : undefined,
              collaborationMode: current.collaboration === "plan" ? "plan" : undefined,
              followUpQueueMode: current.followUpQueueMode,
            },
            goal: current.goal ?? undefined,
            goalStatus: current.goal ? (current.goalStatus ?? undefined) : undefined,
          });
          rememberAgent(agent, effectiveId);
          rememberDraftSelection(key, null);
          const sessionId = created.sessions[created.sessions.length - 1]?.id;
          // 文字跟着发出去了；附件、片段、选项都清掉，新会话页回到空白。
          if (sessionId) {
            moveDraft(key, sessionId, {});
            usePanelStore.getState().panelMoveSession(key, sessionId);
          }
          openTask(created.id, projectId);
          return true;
        } catch (error) {
          showError(error);
          return false;
        } finally {
          setCreating(false);
        }
      },
      setCollaborationMode: async (mode) => patch({ collaboration: mode }),
      startReview: async () => {},
      reviewTargets: () => Promise.reject(new Error("先发一条消息")),
      answerPrompt: async () => false,
      setSandbox: (next) => {
        rememberSandbox(agent, next, effectiveId);
        patch({ sandbox: next });
      },
      setTuning: (model, effort, serviceTier) => {
        const next: SessionTuning = { model, effort };
        if (serviceTier !== undefined) next.serviceTier = serviceTier;
        else if (tuning?.serviceTier !== undefined) next.serviceTier = tuning.serviceTier;
        rememberTuning(agent, next, effectiveId);
        patch({ tuning: next });
      },
      updateQueued: async () => {},
      removeQueued: async () => {},
      steerQueued: async () => {},
      flushQueued: async () => {},
      setFollowUpQueueMode: (mode) => patch({ followUpQueueMode: mode }),
      interrupt: () => {},
      setGoal: async (objective) => patch({ goal: objective.trim(), goalStatus: draft.goalStatus ?? "active" }),
      clearGoal: async () => patch({ goal: null, goalStatus: null }),
      setGoalStatus: async (status) => patch({ goalStatus: status }),
      publishGoal: async () => {},
      filterPaths: (query) =>
        projectId
          ? filterPaths({ projectId }, query)
          : Promise.resolve({ paths: [], truncated: false, cancelled: false, ready: true }),
      reportError: showError,
    };
  }, [
    agent,
    catalog,
    creating,
    draft,
    effectiveId,
    hasCommit,
    key,
    notice,
    permissionMenu,
    profile,
    profiles,
    project,
    projectId,
    projects,
    sandbox,
    selectableInstances,
    tuning,
  ]);
}
