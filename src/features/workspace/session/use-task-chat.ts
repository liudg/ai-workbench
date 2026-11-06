import { useMemo } from "react";

import { useAgentProfiles } from "@/features/agents";
import type { ChatHost } from "@/features/chat/host";
import type { Project } from "@/features/projects";
import type { TaskEntry, TaskSession } from "@/features/tasks";
import { openSubagent } from "@/shared/shell/navigation";
import type { PromptAnswer } from "@/types";
import { answerPrompt } from "./api";
import { chatSession } from "./chat-session";
import { addDraftSnippet, useComposerDraft } from "./composer-drafts";
import { useSessionStart } from "./session-start";
import { useSubtaskHost } from "./use-subtask-host";
import { useTaskTimeline } from "./use-task-timeline";

/** 一个任务的聊天要的东西：时间线、聊天宿主、草稿。主区的会话视图和面板里并排看的子任务共用。 */
export function useTaskChat(task: TaskEntry, taskSession: TaskSession, project: Project | undefined) {
  const profiles = useAgentProfiles();
  const session = useMemo(() => chatSession(task, taskSession), [task, taskSession]);
  const workdir = session.workdir?.trim() || project?.path || "";
  const timeline = useTaskTimeline(task, taskSession);
  const { agentOf } = timeline;
  const subtasks = useSubtaskHost(session.id);
  const taskId = task.id;
  const projectId = task.projectId ?? null;
  const host = useMemo<ChatHost>(
    () => ({
      answerPrompt: (sessionId: string, promptId: string, answer: PromptAnswer) =>
        answerPrompt(sessionId, promptId, answer).then(
          () => true,
          () => false,
        ),
      profiles,
      projectPath: workdir,
      addTextSnippet: addDraftSnippet,
      agentOf,
      subtasks,
      openSubagent: (sessionId, subagentId) => openSubagent(taskId, projectId, { sessionId, subagentId }),
    }),
    [agentOf, profiles, projectId, subtasks, taskId, workdir],
  );
  const starting = useSessionStart(session.id, timeline.current.events, timeline.current.ready);
  const { draft, loaded } = useComposerDraft(session.id);
  return {
    profiles,
    profile: profiles[taskSession.agent],
    session,
    workdir,
    timeline,
    host,
    starting,
    draft,
    loaded,
  };
}
