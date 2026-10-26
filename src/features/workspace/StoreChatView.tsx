// 旧版工作区的聊天视图：时间线要的数据从旧 store 取，作曲栏用旧的 Composer。

import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { Composer } from "@/features/chat/composer/Composer";
import { ChatHostProvider, type ChatHost } from "@/features/chat/host";
import { ChatView } from "@/features/chat/timeline/ChatView";
import { addSessionTextSnippet } from "@/features/panel/core/useAddTextSnippet";
import { useWorkbench } from "@/store";
import type { Session, SessionEvent } from "@/types";

export function StoreChatView({
  session,
  events,
  eventsReady = true,
}: {
  session: Session;
  events: SessionEvent[];
  eventsReady?: boolean;
}) {
  const { answerPrompt, profiles, projectPath, paged, loadOlderHistory } = useWorkbench(
    useShallow((state) => ({
      answerPrompt: state.answerPrompt,
      profiles: state.profiles,
      projectPath: state.projects.find((project) => project.id === session.project_id)?.path ?? "",
      paged: state.catalogs[session.id]?.capabilities.supports_paged_history === true,
      loadOlderHistory: state.loadOlderHistory,
    })),
  );
  const host = useMemo<ChatHost>(
    () => ({
      answerPrompt,
      profiles,
      projectPath,
      loadOlderHistory: paged ? loadOlderHistory : undefined,
      addTextSnippet: (sessionId, draft) => {
        addSessionTextSnippet(sessionId, draft);
      },
    }),
    [answerPrompt, loadOlderHistory, paged, profiles, projectPath],
  );
  return (
    <ChatHostProvider host={host}>
      <ChatView
        session={session}
        events={events}
        eventsReady={eventsReady}
        renderComposer={(anchorRef) => (
          <Composer key={session.id} session={session} events={events} anchorRef={anchorRef} />
        )}
      />
    </ChatHostProvider>
  );
}
