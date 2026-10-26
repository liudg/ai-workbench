import { useMemo } from "react";

import { AnswerMarkdownHost } from "@/features/chat/answer/AnswerMarkdownHost";
import { ChatHostProvider, type ChatHost } from "@/features/chat/host";
import { ChatView } from "@/features/chat/timeline/ChatView";
import { SessionSplit } from "@/features/panel/core/SessionSplit";
import type { TaskEntry, TaskSession } from "@/features/tasks";
import { useSessionFeed } from "@/lib/daemon";
import type { AgentKind, AgentProfile, PromptAnswer } from "@/types";
import { chatSession } from "./chat-session";
import { answerPrompt } from "./task-backend";
import { addTaskSnippet } from "./task-composer-store";
import { TaskComposer } from "./TaskComposer";
import { TaskPanel } from "./TaskPanel";
import { useTaskComposer } from "./use-task-composer";

export function TaskView({
  task,
  projectPath,
  profiles,
}: {
  task: TaskEntry;
  projectPath: string;
  profiles: Partial<Record<AgentKind, AgentProfile>>;
}) {
  const taskSession = task.sessions[0];
  const host = useMemo<ChatHost>(
    () => ({
      answerPrompt: (sessionId: string, promptId: string, answer: PromptAnswer) =>
        answerPrompt(sessionId, promptId, answer).then(
          () => true,
          () => false,
        ),
      profiles,
      projectPath,
      addTextSnippet: addTaskSnippet,
    }),
    [profiles, projectPath],
  );
  if (!taskSession) return null;
  return (
    <ChatHostProvider host={host}>
      <TaskChat
        key={taskSession.id}
        task={task}
        taskSession={taskSession}
        projectPath={projectPath}
        profile={profiles[taskSession.agent]}
      />
    </ChatHostProvider>
  );
}

function TaskChat({
  task,
  taskSession,
  projectPath,
  profile,
}: {
  task: TaskEntry;
  taskSession: TaskSession;
  projectPath: string;
  profile: AgentProfile | undefined;
}) {
  const feed = useSessionFeed(taskSession.id);
  const session = useMemo(() => chatSession(task, taskSession), [task, taskSession]);
  const composer = useTaskComposer({
    session,
    taskSession,
    events: feed.events,
    queue: feed.queue,
    profile,
  });
  return (
    <TaskPanel session={session} events={feed.events} projectPath={projectPath} profile={profile}>
      <AnswerMarkdownHost>
        <SessionSplit>
          <ChatView
            session={session}
            events={feed.events}
            eventsReady={feed.ready}
            renderComposer={(anchorRef) => (
              <TaskComposer c={composer} sessionId={session.id} workspace={task.workspace} anchorRef={anchorRef} />
            )}
          />
        </SessionSplit>
      </AnswerMarkdownHost>
    </TaskPanel>
  );
}
