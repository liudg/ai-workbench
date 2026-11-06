import { useEffect } from "react";
import { ArrowUpRight } from "lucide-react";

import { AnswerMarkdownHost } from "@/features/chat/answer/AnswerMarkdownHost";
import { CHAT_SCOPE_ATTR } from "@/features/chat/chat-scope";
import { Composer } from "@/features/chat/composer/Composer";
import { ChatHostProvider } from "@/features/chat/host";
import { ChatView } from "@/features/chat/timeline/ChatView";
import type { ViewerViewProps } from "@/features/panel/core/registry";
import { useProjects } from "@/features/projects";
import { currentSession, useTasks, type TaskEntry, type TaskSession } from "@/features/tasks";
import { openTask } from "@/shared/shell/navigation";
import { useLiveComposer } from "../session/use-live-composer";
import { useTaskChat } from "../session/use-task-chat";
import type { SubtaskPayload } from "./open";

/** 面板标签里的子任务。子任务删掉或归档了只留一句话。 */
export function SubtaskTab({ payload, setTitle }: ViewerViewProps<SubtaskPayload>) {
  const { tasks } = useTasks();
  const task = tasks.find((item) => item.id === payload.taskId && !item.archivedAt);
  const taskSession = task ? currentSession(task) : undefined;
  const title = task?.title.trim() ?? "";
  useEffect(() => {
    if (title) setTitle(title);
  }, [setTitle, title]);
  if (!task || !taskSession) return <p className="px-4 py-6 text-sm text-zinc-500">这个子任务已经不在了</p>;
  return <SubtaskChat key={task.id} task={task} taskSession={taskSession} />;
}

function SubtaskChat({ task, taskSession }: { task: TaskEntry; taskSession: TaskSession }) {
  const { projects } = useProjects();
  const project = task.projectId ? projects.find((item) => item.id === task.projectId) : undefined;
  const chat = useTaskChat(task, taskSession, project);
  const feed = chat.timeline.all;
  const composer = useLiveComposer({
    task,
    taskSession,
    session: chat.session,
    queue: feed.queue,
    draft: chat.draft,
    project,
    profiles: chat.profiles,
  });
  return (
    <ChatHostProvider host={chat.host}>
      <div data-subtask-tab={task.id} {...{ [CHAT_SCOPE_ATTR]: "" }} className="flex h-full min-h-0 flex-col bg-[#0f0f0f]">
        <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-[#222] px-4 text-xs text-zinc-500">
          <span className="min-w-0 flex-1 truncate">{task.title}</span>
          <button
            type="button"
            className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200"
            onClick={() => openTask(task.id, task.projectId ?? null)}
          >
            <ArrowUpRight className="h-3.5 w-3.5" />
            单独打开
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          <AnswerMarkdownHost>
            <ChatView
              session={chat.session}
              events={feed.events}
              eventsReady={feed.ready}
              starting={chat.starting}
              renderComposer={(anchorRef) =>
                chat.loaded ? (
                  <Composer
                    key={chat.session.id}
                    host={composer}
                    session={chat.session}
                    events={chat.timeline.current.events}
                    anchorRef={anchorRef}
                  />
                ) : null
              }
            />
          </AnswerMarkdownHost>
        </div>
      </div>
    </ChatHostProvider>
  );
}
