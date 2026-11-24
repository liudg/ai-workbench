import { useMemo, useSyncExternalStore } from "react";

import {
  useAgentDetection,
  useAgentProfiles,
  useSelectableInstances,
  type SelectableInstance,
} from "@/features/agents";
import { AnswerMarkdownHost, ChatHostProvider, ChatView, Composer, composerModelStatus, type ChatHost } from "@/features/chat";
import { CommandMenuHost } from "@/features/command-menu";
import { SessionSplit } from "@/features/panel";
import type { Project } from "@/features/projects";
import { profileForSessionAgent } from "@/shared/agent/identity";
import { openSettings, type ProjectScope } from "@/shared/shell/navigation";
import type { AgentKind, Session } from "@/types";
import { addDraftSnippet, useComposerDraft, type ComposerDraft } from "../session/composer-drafts";
import { SessionPanel } from "../session/SessionPanel";
import { intentEvents } from "./intent-events";
import { stickyRevision, subscribeSticky } from "./sticky";
import { draftSelection, newSessionKey, useNewComposer } from "./use-new-composer";

/** 新会话：和会话视图一样的时间线和面板，第一条消息发出时才真正建会话。 */
export function NewSessionView({ projectId, project, projects }: {
  projectId: ProjectScope;
  project: Project | undefined;
  projects: Project[];
}) {
  const key = newSessionKey(projectId);
  useSyncExternalStore(subscribeSticky, stickyRevision, stickyRevision);
  const selectableInstances = useSelectableInstances();
  const detection = useAgentDetection();
  const { draft, loaded } = useComposerDraft(key);
  const selection = draftSelection(key, draft, selectableInstances);

  if (!loaded) return null;
  if (!selection && selectableInstances === null && detection.error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="break-words text-sm text-wb-fg-2">检测本地 Agent 失败：{detection.error}</p>
        <button type="button" className="text-sm font-medium text-wb-accent-ink transition-colors hover:underline" onClick={detection.retry}>
          重试
        </button>
        <CommandMenuHost />
      </div>
    );
  }
  // 本机 Agent 还在检测：记得上次用的就先用它，否则等检测完。
  if (!selection && selectableInstances === null) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-wb-fg-3">
        正在检测本地 Agent…
        <CommandMenuHost />
      </div>
    );
  }
  if (!selection) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <p className="text-sm text-wb-fg-2">未检测到可用的本地 Agent</p>
        <button type="button" className="text-sm font-medium text-wb-accent-ink transition-colors hover:underline" onClick={openSettings}>
          打开设置
        </button>
        <CommandMenuHost />
      </div>
    );
  }
  return (
    <NewSession
      key={key}
      projectId={projectId}
      project={project}
      projects={projects}
      agent={selection.agent}
      instanceId={selection.instanceId}
      selectableInstances={selectableInstances}
      draft={draft}
    />
  );
}

function NewSession({
  projectId,
  project,
  projects,
  agent,
  instanceId,
  selectableInstances,
  draft,
}: {
  projectId: ProjectScope;
  project: Project | undefined;
  projects: Project[];
  agent: AgentKind;
  instanceId: string;
  selectableInstances: SelectableInstance[] | null;
  draft: ComposerDraft;
}) {
  const profiles = useAgentProfiles();
  const key = newSessionKey(projectId);

  const session = useMemo<Session>(
    () => ({
      id: key,
      project_id: projectId ?? "",
      agent,
      native_id: "",
      title: project?.name ?? "聊天",
      status: "completed",
      created_at: 0,
      updated_at: 0,
    }),
    [agent, key, project?.name, projectId],
  );
  const events = useMemo(
    () =>
      intentEvents(key, {
        plan: draft.collaboration === "plan",
        goal: draft.goal ?? null,
        goalStatus: draft.goalStatus ?? null,
      }),
    [draft.collaboration, draft.goal, draft.goalStatus, key],
  );
  const workdir = project?.path ?? "";
  const host = useMemo<ChatHost>(
    () => ({
      answerPrompt: async () => false,
      profiles,
      projectPath: workdir,
      addTextSnippet: addDraftSnippet,
      instanceOf: () => instanceId,
    }),
    [instanceId, profiles, workdir],
  );
  const composer = useNewComposer({
    projectId,
    project,
    projects,
    agent,
    instanceId,
    selectableInstances,
    profiles,
    draft,
  });
  const { modelLabel, modelLoading } = composerModelStatus(composer);
  const profile = profileForSessionAgent(agent, profiles, instanceId);
  const chat = (
    <ChatView
      session={session}
      events={events}
      renderComposer={(anchorRef) => (
        <Composer key={`${key}:${instanceId}`} host={composer} session={session} events={events} anchorRef={anchorRef} />
      )}
    />
  );
  return (
    <ChatHostProvider host={host}>
      {projectId ? (
        <SessionPanel
          session={session}
          scope={{ projectId }}
          workdir={workdir}
          events={events}
          profile={profile}
          instanceId={instanceId}
          modelLabel={modelLabel}
          modelLoading={modelLoading}
        >
          <AnswerMarkdownHost>
            <SessionSplit>{chat}</SessionSplit>
          </AnswerMarkdownHost>
          <CommandMenuHost />
        </SessionPanel>
      ) : (
        <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-wb-surface">
          <header
            data-chat-header=""
            className="relative z-20 flex h-10 shrink-0 items-center gap-2 border-b border-wb-border bg-wb-surface px-4"
          >
            <span data-session-title className="min-w-0 flex-1 truncate text-sm font-medium text-wb-fg">
              新建对话
            </span>
          </header>
          <AnswerMarkdownHost>{chat}</AnswerMarkdownHost>
          <CommandMenuHost />
        </div>
      )}
    </ChatHostProvider>
  );
}
