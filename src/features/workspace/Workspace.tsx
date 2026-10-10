import { useWorkbench } from "@/store";
import { type SessionEvent } from "@/types";
import { NoProjectSelected, NoSession } from "./empty/EmptyState";
import { ChatView } from "./timeline/ChatView";

const EMPTY_EVENTS: SessionEvent[] = [];

export function Workspace() {
  const selectedProjectId = useWorkbench((s) => s.selectedProjectId);
  const project = useWorkbench((s) =>
    s.projects.find((p) => p.id === s.selectedProjectId),
  );
  const sessions = useWorkbench((s) =>
    selectedProjectId ? s.sessions[selectedProjectId] : undefined,
  );
  const activeSessionId = useWorkbench((s) =>
    selectedProjectId ? s.activeSessionId[selectedProjectId] : undefined,
  );
  const session = sessions?.find((s) => s.id === activeSessionId);
  const events =
    useWorkbench((s) => (session ? s.events[session.id] : undefined)) ??
    EMPTY_EVENTS;

  if (!project) return <NoProjectSelected />;

  return (
    <div className="relative flex h-full min-w-0 flex-1 flex-col">
      {session ? (
        <ChatView session={session} events={events} />
      ) : sessions && sessions.length > 0 ? (
        <div className="flex h-full items-center justify-center px-8 text-center text-sm leading-6 text-zinc-500">
          从左侧选择一个会话。
        </div>
      ) : sessions ? (
        <NoSession projectId={project.id} />
      ) : (
        <div className="flex h-full items-center justify-center text-sm text-zinc-600">
          加载中…
        </div>
      )}
    </div>
  );
}
