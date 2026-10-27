import { useMemo } from "react";

import { useAgentProfiles } from "@/features/agents";
import { AnswerMarkdownHost } from "@/features/chat/answer/AnswerMarkdownHost";
import { Composer } from "@/features/chat/composer/Composer";
import { ChatHostProvider, type ChatHost } from "@/features/chat/host";
import { ChatView } from "@/features/chat/timeline/ChatView";
import { CommandMenuHost } from "@/features/command-menu";
import { SessionSplit } from "@/features/panel/core/SessionSplit";
import type { Project } from "@/features/projects";
import type { TaskEntry, TaskSession } from "@/features/tasks";
import { useSessionFeed } from "@/lib/daemon";
import type { PromptAnswer } from "@/types";
import { answerPrompt } from "./api";
import { chatSession } from "./chat-session";
import { addDraftSnippet, useComposerDraft } from "./composer-drafts";
import { SessionPanel } from "./SessionPanel";
import { useLiveComposer } from "./use-live-composer";

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
    }),
    [profiles, workdir],
  );
  const feed = useSessionFeed(session.id);
  const { draft, loaded } = useComposerDraft(session.id);
  const profile = profiles[taskSession.agent];
  const composer = useLiveComposer({
    task,
    taskSession,
    session,
    queue: feed.queue,
    draft,
    project,
    profile,
  });
  return (
    <ChatHostProvider host={host}>
      <SessionPanel
        session={session}
        scope={{ sessionId: session.id }}
        workdir={workdir}
        events={feed.events}
        profile={profile}
      >
        <AnswerMarkdownHost>
          <SessionSplit>
            <ChatView
              session={session}
              events={feed.events}
              eventsReady={feed.ready}
              renderComposer={(anchorRef) =>
                loaded ? (
                  <Composer key={session.id} host={composer} session={session} events={feed.events} anchorRef={anchorRef} />
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
