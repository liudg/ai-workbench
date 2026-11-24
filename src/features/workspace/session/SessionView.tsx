import { useEffect, useMemo, useState } from "react";

import { AnswerMarkdownHost, ChatHostProvider, ChatView, Composer, composerModelStatus, type ChatHost } from "@/features/chat";
import { CommandMenuHost } from "@/features/command-menu";
import { SessionSplit } from "@/features/panel";
import { usePanelStore } from "@/features/panel/headless";
import type { Project } from "@/features/projects";
import type { TaskEntry, TaskSession } from "@/features/tasks";
import { isReadOnlyOpen } from "@/lib/utils";
import { canOpenSideChat } from "../side-chat/can-open";
import { closeOrphanSideChat, sideChatTarget, startSideChatWith } from "../side-chat/open";
import { registerSideChatViewer } from "../side-chat/viewer";
import { subagentsTarget } from "../subagent-panel/open";
import { registerSubagentsViewer } from "../subagent-panel/viewer";
import { dropDraft, restoreRewoundDraft } from "./composer-drafts";
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
  const occupied = useMemo(() => isReadOnlyOpen(timeline.current.events), [timeline.current.events]);
  const [rewindTarget, setRewindTarget] = useState<{ sessionId: string; userEventId: string } | null>(null);
  const [focusSessionId, setFocusSessionId] = useState<string | null>(null);
  useEffect(() => {
    setRewindTarget(null);
    setFocusSessionId(null);
  }, [task.id]);

  useEffect(() => {
    if (!focusSessionId || focusSessionId !== session.id || !chat.loaded) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const textarea = document.querySelector<HTMLTextAreaElement>(
          "[data-composer-column] textarea",
        );
        if (textarea) {
          textarea.focus();
          const length = textarea.value.length;
          textarea.setSelectionRange(length, length);
        }
        setFocusSessionId((prev) => (prev === session.id ? null : prev));
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
    };
  }, [chat.loaded, focusSessionId, session.id]);

  const sideChatOpen = canOpenSideChat(task, profile, timeline.current.events);
  // 侧边聊天与按轮回退只开在主会话里，子智能体面板里的聊天不带这两项。
  const host = useMemo<ChatHost>(
    () => ({
      ...chat.host,
      requestRewind: occupied
        ? undefined
        : (targetSessionId, userEventId) =>
            setRewindTarget({ sessionId: targetSessionId, userEventId }),
      startSideChat: sideChatOpen ? (draft) => startSideChatWith(session.id, task.id, draft) : undefined,
    }),
    [chat.host, occupied, session.id, sideChatOpen, task.id],
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
  const { modelLabel, modelLoading } = composerModelStatus(composer);
  return (
    <ChatHostProvider host={host}>
      <SessionPanel
        session={session}
        scope={{ sessionId: session.id }}
        workdir={chat.workdir}
        events={feed.events}
        profile={profile}
        instanceId={taskSession.instanceId ?? null}
        modelLabel={modelLabel}
        modelLoading={modelLoading}
        sideChat={sideChat}
        subagents={subagentsTarget}
      >
        <AnswerMarkdownHost>
          <SessionSplit>
            <ChatView
              session={session}
              events={feed.events}
              eventsReady={feed.ready}
              taskId={task.id}
              rewindTarget={rewindTarget}
              onCloseRewind={() => setRewindTarget(null)}
              onRewindComplete={({ activeSessionId, text, files }) => {
                setRewindTarget(null);
                if (activeSessionId !== session.id) {
                  dropDraft(session.id);
                  usePanelStore.getState().panelMoveSession(session.id, activeSessionId);
                }
                void restoreRewoundDraft(activeSessionId, { text, files }).then(() => {
                  setFocusSessionId(activeSessionId);
                });
              }}
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
