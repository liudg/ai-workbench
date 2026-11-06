import { useEffect, useMemo } from "react";

import { AnswerMarkdownHost } from "@/features/chat/answer/AnswerMarkdownHost";
import { Composer } from "@/features/chat/composer/Composer";
import { ChatHostProvider, type ChatHost } from "@/features/chat/host";
import { ChatView } from "@/features/chat/timeline/ChatView";
import { CommandMenuHost } from "@/features/command-menu";
import { SessionSplit } from "@/features/panel/core/SessionSplit";
import type { Project } from "@/features/projects";
import type { TaskEntry, TaskSession } from "@/features/tasks";
import { canOpenSideChat } from "../side-chat/can-open";
import { closeOrphanSideChat, sideChatTarget, startSideChatWith } from "../side-chat/open";
import { registerSideChatViewer } from "../side-chat/viewer";
import { subagentsTarget } from "../subagent-panel/open";
import { registerSubagentsViewer } from "../subagent-panel/viewer";
import { SessionPanel } from "./SessionPanel";
import { useLiveComposer } from "./use-live-composer";
import { useTaskChat } from "./use-task-chat";

registerSideChatViewer();
registerSubagentsViewer();

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
  const chat = useTaskChat(task, taskSession, project);
  const { session, timeline, profile, profiles } = chat;
  const feed = timeline.all;
  const sideChatOpen = canOpenSideChat(task, profile, timeline.current.events);
  // 侧边聊天开在这个会话的面板里，子智能体面板里的聊天不带这一项。
  const host = useMemo<ChatHost>(
    () => ({
      ...chat.host,
      startSideChat: sideChatOpen ? (draft) => startSideChatWith(session.id, task.id, draft) : undefined,
    }),
    [chat.host, session.id, sideChatOpen, task.id],
  );
  // 只在打开会话时看一次：之后打开的侧边聊天，标签总在 daemon 建好它之前放上。
  useEffect(() => closeOrphanSideChat(session.id, task), [session.id]);
  const sideChat = useMemo(() => (sideChatOpen ? () => sideChatTarget(task.id) : null), [sideChatOpen, task.id]);
  const composer = useLiveComposer({
    task,
    taskSession,
    session,
    queue: feed.queue,
    draft: chat.draft,
    project,
    profiles,
    canOpenSide: sideChatOpen,
  });
  return (
    <ChatHostProvider host={host}>
      <SessionPanel
        session={session}
        scope={{ sessionId: session.id }}
        workdir={chat.workdir}
        events={feed.events}
        profile={profile}
        sideChat={sideChat}
        subagents={subagentsTarget}
      >
        <AnswerMarkdownHost>
          <SessionSplit>
            <ChatView
              session={session}
              events={feed.events}
              eventsReady={feed.ready}
              starting={chat.starting}
              renderComposer={(anchorRef) =>
                chat.loaded ? (
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
