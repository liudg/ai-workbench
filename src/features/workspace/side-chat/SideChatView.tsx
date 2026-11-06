import { useMemo } from "react";

import { useAgentProfiles } from "@/features/agents";
import { AnswerMarkdownHost } from "@/features/chat/answer/AnswerMarkdownHost";
import { CHAT_SCOPE_ATTR } from "@/features/chat/chat-scope";
import { Composer } from "@/features/chat/composer/Composer";
import { ChatHostProvider, type ChatHost } from "@/features/chat/host";
import { ChatView } from "@/features/chat/timeline/ChatView";
import type { ViewerViewProps } from "@/features/panel/core/registry";
import { useProjects } from "@/features/projects";
import { useTasks, type TaskEntry, type TaskSession } from "@/features/tasks";
import { useSessionFeeds, type SessionFeedState } from "@/lib/daemon";
import type { PromptAnswer } from "@/types";
import { answerPrompt } from "../session/api";
import { chatSession } from "../session/chat-session";
import { addDraftSnippet, useComposerDraft } from "../session/composer-drafts";
import { useLiveComposer } from "../session/use-live-composer";
import type { SideChatPayload } from "./open";

const NOT_READY: SessionFeedState = { ready: false, events: [], queue: [] };

/** 面板里的侧边聊天标签。任务里没有开着的侧边聊天时（被关掉、daemon 重启）只留一句话。 */
export function SideChatTab({ payload, status }: ViewerViewProps<SideChatPayload>) {
  const { tasks } = useTasks();
  const task = tasks.find((item) => item.id === payload.taskId);
  if (status === "error") return <Notice text={payload.error ?? "侧边聊天已关闭"} tone="error" />;
  const side = task?.sides?.find((item) => item.id === payload.sideId);
  if (task && side) return <SideChat task={task} side={side} />;
  return status === "loading" ? null : <Notice text="侧边聊天已关闭" />;
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
      <div data-side-chat {...{ [CHAT_SCOPE_ATTR]: "" }} className="flex h-full min-h-0 flex-col bg-[#0f0f0f]">
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
