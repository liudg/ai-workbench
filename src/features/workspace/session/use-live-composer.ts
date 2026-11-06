// 已经建好的会话的作曲栏：选项写进 daemon，发送、排队、目标、审查都走 daemon。
// 两边都能交接时，模型菜单的 Agent 竖栏可以换到别的 Agent，前文由 daemon 交过去。

import { useEffect, useMemo, useState } from "react";

import { agentsApi, useSessionAgents } from "@/features/agents";
import type { AgentOption, ComposerHost } from "@/features/chat/composer/host";
import { suggestedBranchName, worktreeCaption } from "@/features/chat/composer/worktree-option";
import { projectsApi, type Project } from "@/features/projects";
import { tasksApi, type SessionOptions, type TaskEntry, type TaskSession } from "@/features/tasks";
import { agentIdentity } from "@/shared/agent/identity";
import { rememberProjectBranch } from "@/shared/project-branch";
import { showError } from "@/shared/shell/error-banner";
import type { AgentKind, AgentProfile, QueuedTurn, Session, SessionSandbox, SessionTuning } from "@/types";
import * as api from "./api";
import { moveDraft, patchDraft, readDraft, removeDraftSnippet, type ComposerDraft } from "./composer-drafts";
import { askInSideChat } from "../side-chat/open";
import { useSessionCatalog } from "./use-session-catalog";

function toSandbox(options: SessionOptions): SessionSandbox | null {
  const access = options.access;
  if (!access) return null;
  return {
    mode: access.mode as SessionSandbox["mode"],
    networkAccess: access.networkAccess,
    writableRoots: access.writableRoots,
    profileId: access.profileId,
  };
}

function toTuning(options: SessionOptions): SessionTuning | undefined {
  if (!options.model) return undefined;
  const tuning: SessionTuning = { model: options.model, effort: options.effort ?? "" };
  if (options.serviceTier !== undefined) tuning.serviceTier = options.serviceTier || null;
  return tuning;
}

export function useLiveComposer({
  task,
  taskSession,
  session,
  queue,
  draft,
  project,
  profiles,
  side = false,
  canOpenSide = false,
}: {
  task: TaskEntry;
  taskSession: TaskSession;
  session: Session;
  queue: QueuedTurn[];
  draft: ComposerDraft;
  project: Project | undefined;
  profiles: Partial<Record<AgentKind, AgentProfile>>;
  /** 侧边聊天的作曲栏：不换 Agent。 */
  side?: boolean;
  /** 主对话现在能开侧边聊天，排队消息可以挪过去问。 */
  canOpenSide?: boolean;
}): ComposerHost {
  const sessionId = session.id;
  const { catalog, notice, permissionMenu } = useSessionCatalog(sessionId, taskSession.agent);
  const options = taskSession.options;
  const profile = profiles[taskSession.agent];
  const agents = useSessionAgents();
  const [restoring, setRestoring] = useState(false);
  const [handingOff, setHandingOff] = useState(false);
  // 换到别的任务时不带着上一个任务的“恢复中”“交接中”。
  useEffect(() => {
    setRestoring(false);
    setHandingOff(false);
  }, [task.id]);

  return useMemo<ComposerHost>(() => {
    const report = (error: unknown) => showError(error);
    const writeOptions = (patch: Partial<SessionOptions>) => {
      void api.setSessionOptions(sessionId, { ...options, ...patch }).catch(report);
    };
    const quiet = <T,>(work: Promise<T>) => work.then(() => undefined, report);
    const worktree = task.workspace.kind === "worktree" ? task.workspace : null;
    const localBranch = worktree?.local?.branch ?? null;
    // 侧边聊天里不交接：交接要停掉任务的会话，侧边聊天会跟着丢掉。
    const canMove = profiles[taskSession.agent]?.capabilities.supports_workdir_move === true;
    const moveTask = async (branch?: string) => {
      setHandingOff(true);
      const projectId = task.projectId;
      try {
        await tasksApi.handOff(task.id, localBranch ? "worktree" : "local", branch);
      } finally {
        setHandingOff(false);
      }
      // 交接换了项目目录的分支，侧栏跟着刷新。
      if (projectId) {
        void projectsApi
          .currentBranch({ projectId })
          .then((name) => rememberProjectBranch(projectId, name), () => undefined);
      }
    };
    const handOff = worktree && !side && canMove
      ? {
          localBranch,
          suggestedBranch: suggestedBranchName(task.title, task.id),
          busy: handingOff,
          onHandOff: () => void quiet(moveTask()),
          onHandOffAs: (branch: string) => moveTask(branch),
        }
      : null;
    const handsOff = (agent: AgentKind) => profiles[agent]?.capabilities.supports_context_handoff === true;
    const idle = taskSession.status !== "starting" && taskSession.status !== "running" && taskSession.status !== "needs-input";
    const switchable = !side && idle && handsOff(taskSession.agent);
    const option = (agent: AgentKind, fallback: string): AgentOption => ({
      kind: agent,
      name: profiles[agent]?.display_name || fallback,
      identity: agentIdentity(agent, profiles[agent]),
    });
    // 交给了项目目录的任务以后还要交回工作树，只能换到能换目录接着会话的 Agent。
    const movable = (agent: AgentKind) =>
      !worktree?.local || profiles[agent]?.capabilities.supports_workdir_move === true;
    const others = switchable
      ? (agents ?? []).filter(
          (item) => item.kind !== taskSession.agent && handsOff(item.kind) && movable(item.kind),
        )
      : [];
    return {
      draft: false,
      inputLocked: false,
      initialText: readDraft(sessionId).text,
      initialFileRefs: readDraft(sessionId).fileRefs ?? [],
      catalog,
      catalogNotice: notice,
      profile,
      tuning: toTuning(options),
      sandbox: toSandbox(options),
      permissionMenu,
      projectPath: session.workdir?.trim() || project?.path || "",
      files: draft.files,
      snippets: draft.snippets,
      queue,
      followUpQueueMode: options.followUpQueueMode === "steer" ? "steer" : "queue",
      git: project ? { projectId: project.id, projectName: project.name, sessionId } : null,
      workContext: null,
      worktree: worktree?.local
        ? { showToggle: false, pressed: false, onToggle: () => {}, liveLabel: "", liveTitle: "", handOff }
        : worktree
        ? {
            showToggle: false,
            pressed: false,
            onToggle: () => {},
            liveLabel: worktreeCaption(worktree.path),
            liveTitle: worktree.path,
            base: worktree.baseRef ?? null,
            sha: worktree.baseSha,
            shelved: worktree.shelved
              ? {
                  restoring,
                  onRestore: () => {
                    setRestoring(true);
                    void tasksApi
                      .restoreWorktree(task.id)
                      .catch(report)
                      .finally(() => setRestoring(false));
                  },
                }
              : null,
            handOff,
          }
        : null,
      agentChoice: {
        options: [
          option(taskSession.agent, taskSession.agent),
          ...others.map((item) => option(item.kind, item.display_name)),
        ],
        selected: taskSession.agent,
        switcher:
          others.length > 0
            ? {
                loadModels: (agent) =>
                  agentsApi.probeCatalog(agent, task.projectId ?? null).then((found) => found.models),
                onPick: (agent, model) => {
                  const next: SessionOptions = {
                    model: model.id,
                    effort: model.default_effort || undefined,
                    followUpQueueMode: options.followUpQueueMode,
                  };
                  void tasksApi.switchAgent(task.id, agent, next).then((entry) => {
                    // 没发出去的字和附件跟到新的一段。
                    const target = entry.sessions[entry.sessions.length - 1]?.id;
                    if (!target || target === sessionId) return;
                    const { text, files, snippets } = readDraft(sessionId);
                    moveDraft(sessionId, target, { text, files, snippets });
                  }, report);
                },
              }
            : null,
      },

      rememberText: (text) => {
        if (readDraft(sessionId).text !== text) patchDraft(sessionId, { text });
      },
      rememberFileRefs: (fileRefs) => patchDraft(sessionId, { fileRefs }),
      send: (text, images, now) =>
        api.sendMessage(sessionId, text, images, now).then(
          () => true,
          (error: unknown) => {
            report(error);
            return false;
          },
        ),
      setCollaborationMode: async (mode) => writeOptions({ collaborationMode: mode }),
      startReview: (target) => quiet(api.startReview(sessionId, target)),
      reviewTargets: () => api.reviewTargets(sessionId),
      answerPrompt: (promptId, answer) =>
        api.answerPrompt(sessionId, promptId, answer).then(
          () => true,
          (error: unknown) => {
            report(error);
            return false;
          },
        ),
      setSandbox: (next) => writeOptions({ access: { ...next } }),
      setTuning: (model, effort, serviceTier) =>
        // 速度档：undefined 是没动过，null 是关掉，写进 daemon 时关掉记成空串。
        writeOptions({
          model,
          effort,
          serviceTier: serviceTier === undefined ? options.serviceTier : (serviceTier ?? ""),
        }),
      addAttachments: (files) => {
        const current = readDraft(sessionId).files;
        const fresh = files.filter((file) => !current.some((item) => item.path === file.path));
        if (fresh.length > 0) patchDraft(sessionId, { files: [...current, ...fresh] });
      },
      removeAttachment: (path) =>
        patchDraft(sessionId, { files: readDraft(sessionId).files.filter((file) => file.path !== path) }),
      clearAttachments: () => patchDraft(sessionId, { files: [] }),
      replaceAttachments: (files) => patchDraft(sessionId, { files }),
      clearTextSnippets: () => patchDraft(sessionId, { snippets: [] }),
      removeTextSnippet: (id) => removeDraftSnippet(sessionId, id),
      updateQueued: (id, text, images) => quiet(api.updateQueued(sessionId, id, text, images)),
      removeQueued: (id) => quiet(api.removeQueued(sessionId, id)),
      steerQueued: (id) => quiet(api.steerQueued(sessionId, id)),
      openInSideChat: canOpenSide ? (item) => askInSideChat(sessionId, task.id, item) : undefined,
      flushQueued: (ids) => quiet(api.flushQueued(sessionId, ids)),
      setFollowUpQueueMode: (mode) => writeOptions({ followUpQueueMode: mode }),
      interrupt: () => void api.interruptTurn(sessionId).catch(report),
      setGoal: (objective) => api.setGoal(sessionId, objective).then(() => undefined),
      clearGoal: () => api.clearGoal(sessionId).then(() => undefined),
      setGoalStatus: (status) => api.setGoalStatus(sessionId, status).then(() => undefined),
      publishGoal: () => api.publishGoal(sessionId).then(() => undefined),
      filterPaths: (query) => api.filterPaths({ sessionId }, query),
      reportError: report,
    };
  }, [
    agents,
    catalog,
    draft,
    notice,
    options,
    permissionMenu,
    profile,
    profiles,
    project,
    queue,
    restoring,
    handingOff,
    session.workdir,
    sessionId,
    side,
    canOpenSide,
    task.id,
    task.title,
    task.projectId,
    task.workspace,
    taskSession.agent,
    taskSession.status,
  ]);
}
