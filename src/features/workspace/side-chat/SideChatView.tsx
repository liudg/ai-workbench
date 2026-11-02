import { useMemo } from "react";

import { useAgentProfiles } from "@/features/agents";
import { AnswerMarkdownHost } from "@/features/chat/answer/AnswerMarkdownHost";
import { Composer } from "@/features/chat/composer/Composer";
import { ChatHostProvider, type ChatHost } from "@/features/chat/host";
import { ChatView } from "@/features/chat/timeline/ChatView";
import type { ViewerViewProps } from "@/features/panel/core/registry";
import { useProjects } from "@/features/projects";
import { currentSession, useTasks, type TaskEntry, type TaskSession } from "@/features/tasks";
import { useSessionFeeds, type SessionFeedState } from "@/lib/daemon";
import type { PromptAnswer } from "@/types";
import { answerPrompt } from "../session/api";
import { chatSession } from "../session/chat-session";
import { addDraftSnippet, useComposerDraft } from "../session/composer-drafts";
import { useLiveComposer } from "../session/use-live-composer";
import { mainStatusNote, SIDE_COPY } from "./main-status";
import type { SideChatPayload } from "./open";

const NOT_READY: SessionFeedState = { ready: false, events: [], queue: [] };

/** 面板里的侧边聊天标签。任务里没有开着的侧边聊天时（被关掉、daemon 重启）只留一句话。 */
export function SideChatTab({ payload, status }: ViewerViewProps<SideChatPayload>) {
  const { tasks } = useTasks();
  const task = tasks.find((item) => item.id === payload.taskId);
  if (status === "error") return <Notice text={payload.error ?? SIDE_COPY.closed} tone="error" />;
  if (task?.side) return <SideChat task={task} side={task.side} />;
  return status === "loading" ? null : <Notice text={SIDE_COPY.closed} />;
}

function Notice({ text, tone }: { text: string; tone?: "error" }) {
  return (
    <p className={tone === "error" ? "px-4 py-6 text-sm text-red-300" : "px-4 py-6 text-sm text-zinc-500"}>{text}</p>
  );
}

function SideChat({ task, side }: { task: TaskEntry; side: TaskSession }) {
  const profiles = useAgentProfiles();
  const { projects } = useProjects();
  const project = task.projectId ? projects.find((item) => item.id === task.projectId) : undefined;
  const session = useMemo(() => chatSession(task, side), [task, side]);
  const workdir = session.workdir?.trim() || project?.path || "";
  const [feed = NOT_READY] = useSessionFeeds([side.id]);
  const { draft, loaded } = useComposerDraft(side.id);
  const composer = useLiveComposer({
    task,
    taskSession: side,
    session,
    queue: feed.queue,
    draft,
    project,
    profiles,
    side: true,
  });
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
  return (
    <ChatHostProvider host={host}>
      <div data-side-chat data-chat-scope className="flex h-full min-h-0 flex-col bg-[#0f0f0f]">
        <MainStatus main={currentSession(task)} side={side} />
        <div className="flex min-h-0 flex-1 flex-col">
          <AnswerMarkdownHost>
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
          </AnswerMarkdownHost>
        </div>
      </div>
    </ChatHostProvider>
  );
}

/** 主对话现在这段在侧边聊天打开之后有没有变过状态，看它的更新时间。 */
function MainStatus({ main, side }: { main: TaskSession | undefined; side: TaskSession }) {
  const note = main ? mainStatusNote(main.status, main.updatedAt > side.createdAt) : null;
  return (
    <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-[#222] px-4 text-xs text-zinc-500">
      <span>{SIDE_COPY.fromMain}</span>
      {note ? (
        <>
          <span aria-hidden>·</span>
          <span className={main?.status === "needs-input" ? "text-amber-300" : "text-zinc-400"}>{note}</span>
        </>
      ) : null}
    </div>
  );
}
