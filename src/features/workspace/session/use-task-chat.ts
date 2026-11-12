import { useMemo } from "react";

import { useAgentProfiles } from "@/features/agents";
import type { ChatHost } from "@/features/chat";
import type { Project } from "@/features/projects";
import type { TaskEntry, TaskSession } from "@/features/tasks";
import type { PromptAnswer } from "@/types";
import { answerPrompt } from "./api";
import { openSubagentPanel } from "../subagent-panel/open";
import { chatSession } from "./chat-session";
import { addDraftSnippet, useComposerDraft } from "./composer-drafts";
import { useSubtaskHost } from "./use-subtask-host";
import { useTaskTimeline } from "./use-task-timeline";

/**
 * 一个任务的聊天要的东西：时间线、聊天宿主、草稿。主区的会话视图和子智能体面板共用。
 * 在面板里时 `panelOwner` 是面板所在的主会话，时间线里再点开的子智能体落在同一个面板。
 */
export function useTaskChat(
  task: TaskEntry,
  taskSession: TaskSession,
  project: Project | undefined,
  panelOwner?: string,
) {
  const profiles = useAgentProfiles();
  const session = useMemo(() => chatSession(task, taskSession), [task, taskSession]);
  const workdir = session.workdir?.trim() || project?.path || "";
  const timeline = useTaskTimeline(task, taskSession);
  const { agentOf } = timeline;
  const owner = panelOwner ?? session.id;
  const subtasks = useSubtaskHost();
  const taskId = task.id;
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
      openSubagent: (sessionId, subagentId) =>
        openSubagentPanel(owner, { kind: "native", taskId, sessionId, subagentId }),
    }),
    [agentOf, owner, profiles, subtasks, taskId, workdir],
  );
  const { draft, loaded } = useComposerDraft(session.id);
  return {
    profiles,
    profile: profiles[taskSession.agent],
    session,
    workdir,
    timeline,
    host,
    draft,
    loaded,
  };
}
