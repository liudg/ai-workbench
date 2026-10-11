import { useWorkbench } from "@/store";
import { type SessionEvent } from "@/types";
import { ChatView } from "@/features/chat/timeline/ChatView";
import { PanelTabs } from "@/features/panel/core/PanelTabs";
import { PanelProvider } from "@/features/panel/core/PanelProvider";
import { SessionFiles } from "@/features/panel/files/SessionFiles";
import { NoProjectSelected, NoSession } from "./empty/EmptyState";

const EMPTY_EVENTS: SessionEvent[] = [];

export function Workspace() {
  const selectedProjectId = useWorkbench((s) => s.selectedProjectId);
  const project = useWorkbench((s) =>
    s.projects.find((p) => p.id === s.selectedProjectId),
  );
  const sessions = useWorkbench((s) =>
    selectedProjectId ? s.sessions[selectedProjectId] : undefined,
  );
  const archivedSessions = useWorkbench((s) =>
    selectedProjectId ? s.archivedSessions[selectedProjectId] : undefined,
  );
  const activeSessionId = useWorkbench((s) =>
    selectedProjectId ? s.activeSessionId[selectedProjectId] : undefined,
  );
  const session =
    sessions?.find((s) => s.id === activeSessionId) ??
    archivedSessions?.find((s) => s.id === activeSessionId);
  const events =
    useWorkbench((s) => (session ? s.events[session.id] : undefined)) ??
    EMPTY_EVENTS;

  if (!project) return <NoProjectSelected />;

  if (session) {
    return (
      <PanelProvider
        sessionId={session.id}
        projectId={project.id}
        projectPath={project.path}
        events={events}
      >
        <div className="flex h-full min-w-0 flex-1">
          <div className="relative flex h-full min-w-0 flex-1 flex-col">
            <ChatView session={session} events={events} />
          </div>
          <PanelTabs />
          <SessionFiles sessionId={session.id} />
        </div>
      </PanelProvider>
    );
  }

  return (
    <div className="relative flex h-full min-w-0 flex-1 flex-col">
      {sessions && sessions.length > 0 ? (
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
