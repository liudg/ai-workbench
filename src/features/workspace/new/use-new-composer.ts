// 还没建好的新会话的作曲栏：Agent、模型、权限、计划、目标、工作树都先记在草稿里，
// 第一条消息发出时一起交给 daemon 建任务，建好就跳到这个会话。

import { useEffect, useMemo, useState } from "react";

import { agentsApi } from "@/features/agents";
import type { AgentOption, ComposerHost } from "@/features/chat/composer/host";
import { projectsApi, type Project } from "@/features/projects";
import { tasksApi } from "@/features/tasks";
import { agentIdentity } from "@/shared/agent/identity";
import { showError } from "@/shared/shell/error-banner";
import { openNewSession, openTask, type ProjectScope } from "@/shared/shell/navigation";
import type {
  AgentCatalog,
  AgentInstallation,
  AgentKind,
  AgentProfile,
  PermissionMenu,
  SessionTuning,
} from "@/types";
import { filterPaths } from "../session/api";
import { moveDraft, patchDraft, readDraft, type ComposerDraft } from "../session/composer-drafts";
import { usePanelStore } from "@/features/panel/state/store";
import { beginSessionStart } from "../session/session-start";
import { initialSandbox } from "@/lib/sandbox";
import { rememberAgent, rememberSandbox, rememberTuning, stickyAgent, stickySandbox, stickyTuning } from "./sticky";

const STANDALONE = "chat";
const NO_QUEUE: never[] = [];
/** 没有上次的目录，现探也没探到。 */
const NO_CATALOG = "暂无模型列表，使用 Agent 默认模型";

export function newSessionKey(projectId: ProjectScope): string {
  return `new:${projectId ?? STANDALONE}`;
}

/** 草稿里选过的，其次上次选的，再其次第一个能对话的。都没有时为 null。 */
export function draftAgent(draft: ComposerDraft, agents: AgentInstallation[] | null): AgentKind | null {
  const usable = agents?.map((item) => item.kind) ?? [];
  for (const candidate of [draft.agent, stickyAgent()]) {
    if (candidate && (agents === null || usable.includes(candidate))) return candidate;
  }
  return usable[0] ?? null;
}

function useAgentCatalog(agent: AgentKind | null, projectId: ProjectScope) {
  const [catalog, setCatalog] = useState<AgentCatalog | undefined>(undefined);
  const [missing, setMissing] = useState(false);
  const [permissionMenu, setPermissionMenu] = useState<PermissionMenu | null>(null);
  useEffect(() => {
    setCatalog(undefined);
    setMissing(false);
    setPermissionMenu(null);
    if (!agent) return;
    let cancelled = false;
    let probed = false;
    // 存下的目录先显示，现探的新目录到了再换掉。
    void agentsApi.cachedCatalog(agent).then(
      (stored) => {
        if (!cancelled && !probed && stored) setCatalog(stored);
      },
      () => {},
    );
    void agentsApi.probeCatalog(agent, projectId).then(
      (next) => {
        probed = true;
        if (!cancelled) setCatalog(next);
      },
      () => {
        probed = true;
        if (!cancelled) setMissing(true);
      },
    );
    void agentsApi.draftPermissionMenu(agent).then(
      (menu) => {
        if (!cancelled) setPermissionMenu(menu);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [agent, projectId]);
  return { catalog, permissionMenu, notice: missing ? NO_CATALOG : null };
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
  agents,
  profiles,
  draft,
}: {
  projectId: ProjectScope;
  project: Project | undefined;
  projects: Project[];
  agent: AgentKind;
  agents: AgentInstallation[] | null;
  profiles: Partial<Record<AgentKind, AgentProfile>>;
  draft: ComposerDraft;
}): ComposerHost {
  const key = newSessionKey(projectId);
  const [creating, setCreating] = useState(false);
  const { catalog, permissionMenu, notice } = useAgentCatalog(agent, projectId);
  const hasCommit = useHasCommit(projectId);
  const tuning = draft.tuning ?? stickyTuning(agent) ?? undefined;
  const sandbox = draft.sandbox ?? initialSandbox(stickySandbox(agent), profiles[agent]?.default_access);

  return useMemo<ComposerHost>(() => {
    const patch = (next: Partial<ComposerDraft>) => patchDraft(key, next);
    const retarget = (target: ProjectScope) => {
      // 起点分支是这个项目的，换项目就不带过去。
      moveDraft(key, newSessionKey(target), { ...readDraft(key), worktreeBase: null, carryChanges: false });
      openNewSession(target);
    };
    const options: AgentOption[] | null =
      agents?.map((item) => ({
        kind: item.kind,
        name: profiles[item.kind]?.display_name || item.display_name,
        identity: agentIdentity(item.kind, profiles[item.kind]),
      })) ?? null;

    return {
      draft: true,
      inputLocked: creating,
      initialText: readDraft(key).text,
      initialFileRefs: readDraft(key).fileRefs ?? [],
      catalog,
      catalogNotice: notice,
      profile: profiles[agent],
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
        switcher: {
          loadModels: (next) => agentsApi.probeCatalog(next, projectId).then((found) => found.models),
          onPick: (next, model) => {
            const picked: SessionTuning = { model: model.id, effort: model.default_effort };
            rememberAgent(next);
            rememberTuning(next, picked);
            // 权限是上一个 Agent 的，换了就不带过去。
            patch({ agent: next, tuning: picked, sandbox: null });
          },
        },
      },

      rememberText: (text) => {
        if (readDraft(key).text !== text) patch({ text });
      },
      rememberFileRefs: (fileRefs) => patch({ fileRefs }),
      send: async (text, images) => {
        setCreating(true);
        try {
          const current = readDraft(key);
          const created = await tasksApi.createTask({
            projectId,
            agent,
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
          rememberAgent(agent);
          const sessionId = created.sessions[created.sessions.length - 1]?.id;
          // 文字跟着发出去了；附件、片段、选项都清掉，新会话页回到空白。
          if (sessionId) {
            moveDraft(key, sessionId, {});
            usePanelStore.getState().panelMoveSession(key, sessionId);
            if (text.trim() || images.length > 0) beginSessionStart(sessionId, { text, images });
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
        rememberSandbox(agent, next);
        patch({ sandbox: next });
      },
      setTuning: (model, effort, serviceTier) => {
        const next: SessionTuning = { model, effort };
        if (serviceTier !== undefined) next.serviceTier = serviceTier;
        else if (tuning?.serviceTier !== undefined) next.serviceTier = tuning.serviceTier;
        rememberTuning(agent, next);
        patch({ tuning: next });
      },
      addAttachments: (files) => {
        const current = readDraft(key).files;
        const fresh = files.filter((file) => !current.some((item) => item.path === file.path));
        if (fresh.length > 0) patch({ files: [...current, ...fresh] });
      },
      removeAttachment: (path) => patch({ files: readDraft(key).files.filter((file) => file.path !== path) }),
      clearAttachments: () => patch({ files: [] }),
      replaceAttachments: (files) => patch({ files }),
      clearTextSnippets: () => patch({ snippets: [] }),
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
  }, [agent, agents, catalog, notice, sandbox, creating, draft, hasCommit, key, permissionMenu, profiles, project, projectId, projects, tuning]);
}
