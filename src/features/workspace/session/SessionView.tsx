import { useEffect, useMemo } from "react";

import { useAgentProfiles } from "@/features/agents";
import { AnswerMarkdownHost } from "@/features/chat/answer/AnswerMarkdownHost";
import { Composer } from "@/features/chat/composer/Composer";
import { ChatHostProvider, type ChatHost } from "@/features/chat/host";
import { ChatView } from "@/features/chat/timeline/ChatView";
import { CommandMenuHost } from "@/features/command-menu";
import { SessionSplit } from "@/features/panel/core/SessionSplit";
import type { Project } from "@/features/projects";
import type { TaskEntry, TaskSession } from "@/features/tasks";
import type { PromptAnswer } from "@/types";
import { answerPrompt } from "./api";
import { chatSession } from "./chat-session";
import { addDraftSnippet, useComposerDraft } from "./composer-drafts";
import { canOpenSideChat, closeOrphanSideChat, sideChatTarget } from "../side-chat/open";
import { registerSideChatViewer } from "../side-chat/viewer";
import { SessionPanel } from "./SessionPanel";
import { useSessionStart } from "./session-start";
import { useLiveComposer } from "./use-live-composer";
import { useTaskTimeline } from "./use-task-timeline";

registerSideChatViewer();

/** 一个建好的会话：时间线、作曲栏、右侧面板。 */
export function SessionView({
  task,
  taskSession,
  project,
}: {
  task: TaskEntry;
  taskSession: TaskSession;
  project: Project | undefined;
}) {
  const profiles = useAgentProfiles();
  const session = useMemo(() => chatSession(task, taskSession), [task, taskSession]);
  const workdir = session.workdir?.trim() || project?.path || "";
  const timeline = useTaskTimeline(task, taskSession);
  const { agentOf } = timeline;
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
    }),
    [agentOf, profiles, workdir],
  );
  const feed = timeline.all;
  const starting = useSessionStart(session.id, timeline.current.events, timeline.current.ready);
  const { draft, loaded } = useComposerDraft(session.id);
  const profile = profiles[taskSession.agent];
  const sideChatOpen = canOpenSideChat(task, profile);
  // 只在打开会话时看一次：之后打开的侧边聊天，标签总在 daemon 建好它之前放上。
  useEffect(() => closeOrphanSideChat(session.id, task), [session.id]);
  const sideChat = useMemo(() => (sideChatOpen ? sideChatTarget(task.id) : null), [sideChatOpen, task.id]);
  const composer = useLiveComposer({
    task,
    taskSession,
    session,
    queue: feed.queue,
    draft,
    project,
    profiles,
  });
  return (
    <ChatHostProvider host={host}>
      <SessionPanel
        session={session}
        scope={{ sessionId: session.id }}
        workdir={workdir}
        events={feed.events}
        profile={profile}
        sideChat={sideChat}
      >
        <AnswerMarkdownHost>
          <SessionSplit>
            <ChatView
              session={session}
              events={feed.events}
              eventsReady={feed.ready}
              starting={starting}
              renderComposer={(anchorRef) =>
                loaded ? (
                  <Composer
                    key={session.id}
                    host={composer}
                    session={session}
                    events={timeline.current.events}
                    anchorRef={anchorRef}
                  />
                ) : null
              }
            />
          </SessionSplit>
        </AnswerMarkdownHost>
        <CommandMenuHost />
      </SessionPanel>
    </ChatHostProvider>
  );
}
