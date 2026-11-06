import { useEffect, useMemo } from "react";

import { AnswerMarkdownHost } from "@/features/chat/answer/AnswerMarkdownHost";
import { Composer } from "@/features/chat/composer/Composer";
import { ChatHostProvider, type ChatHost } from "@/features/chat/host";
import type { SubagentEvent } from "@/features/chat/events/subagent-display";
import { SubagentView } from "@/features/chat/subagent/SubagentView";
import { ChatView } from "@/features/chat/timeline/ChatView";
import { CommandMenuHost } from "@/features/command-menu";
import { SessionSplit } from "@/features/panel/core/SessionSplit";
import type { Project } from "@/features/projects";
import type { TaskEntry, TaskSession } from "@/features/tasks";
import { showError } from "@/shared/shell/error-banner";
import { closeSubagent, useNavigation, type SubagentRef } from "@/shared/shell/navigation";
import type { SessionEvent } from "@/types";
import { stopSubagent } from "./api";
import { canOpenSideChat } from "../side-chat/can-open";
import { closeOrphanSideChat, sideChatTarget, startSideChatWith } from "../side-chat/open";
import { registerSideChatViewer } from "../side-chat/viewer";
import { registerSubtaskViewer } from "../subtask-panel/viewer";
import { RunningWork } from "./RunningWork";
import { SessionPanel } from "./SessionPanel";
import { useLiveComposer } from "./use-live-composer";
import { useRunningWork } from "./use-running-work";
import { useTaskChat } from "./use-task-chat";

registerSideChatViewer();
registerSubtaskViewer();

/** 一个建好的会话：时间线、作曲栏、右侧面板。打开了它的某个子 Agent 时，聊天区换成那个子 Agent 的视图。 */
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
  // 侧边聊天开在这个会话的面板里，面板里并排看的子任务不带这一项。
  const host = useMemo<ChatHost>(
    () => ({
      ...chat.host,
      startSideChat: sideChatOpen ? (draft) => startSideChatWith(session.id, task.id, draft) : undefined,
    }),
    [chat.host, session.id, sideChatOpen, task.id],
  );
  // 只在打开会话时看一次：之后打开的侧边聊天，标签总在 daemon 建好它之前放上。
  useEffect(() => closeOrphanSideChat(session.id, task), [session.id]);
  const sideChat = useMemo(() => (sideChatOpen ? sideChatTarget(task.id) : null), [sideChatOpen, task.id]);
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
  const running = useRunningWork(task, taskSession, feed.events, profile);
  const view = useNavigation((state) => state.view);
  const subagentRef = view.kind === "task" && view.taskId === task.id ? view.subagent : undefined;
  const subagent = useMemo(() => findCard(feed.events, subagentRef), [feed.events, subagentRef]);
  // 子 Agent 不在这条时间线里了（换过会话、记录被清掉），回到会话本身。
  useEffect(() => {
    if (subagentRef && feed.ready && !subagent) closeSubagent();
  }, [feed.ready, subagent, subagentRef]);
  const canStopSubagent = Boolean(profile?.capabilities.supports_subagent_stop) && subagent?.session_id === taskSession.id;
  return (
    <ChatHostProvider host={host}>
      <SessionPanel
        session={session}
        scope={{ sessionId: session.id }}
        workdir={chat.workdir}
        events={feed.events}
        profile={profile}
        sideChat={sideChat}
      >
        <AnswerMarkdownHost>
          <SessionSplit>
            {subagent ? (
              <SubagentView
                key={subagent.subagent_id}
                card={subagent}
                events={feed.events}
                parent={session}
                onBack={closeSubagent}
                onStop={
                  canStopSubagent
                    ? () => void stopSubagent(subagent.session_id, subagent.subagent_id).catch(showError)
                    : undefined
                }
              />
            ) : (
              <ChatView
                session={session}
                events={feed.events}
                eventsReady={feed.ready}
                starting={chat.starting}
                renderComposer={(anchorRef) =>
                  chat.loaded ? (
                    <>
                      <RunningWork items={running.items} profiles={profiles} onStopAll={running.stopAll} />
                      <Composer
                        key={session.id}
                        host={composer}
                        session={session}
                        events={timeline.current.events}
                        anchorRef={anchorRef}
                      />
                    </>
                  ) : null
                }
              />
            )}
          </SessionSplit>
        </AnswerMarkdownHost>
        <CommandMenuHost />
      </SessionPanel>
    </ChatHostProvider>
  );
}

function findCard(events: readonly SessionEvent[], ref: SubagentRef | undefined): SubagentEvent | undefined {
  if (!ref) return undefined;
  let found: SubagentEvent | undefined;
  for (const event of events) {
    if (event.kind === "subagent" && event.session_id === ref.sessionId && event.subagent_id === ref.subagentId) {
      found = event;
    }
  }
  return found;
}
