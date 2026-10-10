import { useEffect } from "react";

import { ChatView } from "@/components/ChatView";
import { NoProjectSelected, NoSession } from "@/components/EmptyState";
import { NewProjectDialog } from "@/components/NewProjectDialog";
import { SessionTabs } from "@/components/SessionTabs";
import { Sidebar } from "@/components/Sidebar";
import { UpdateDialog } from "@/components/UpdateDialog";
import { useWorkbench } from "@/store";
import { type SessionEvent } from "@/types";

// 稳定空引用：selector 必须返回缓存值，否则 useSyncExternalStore 会无限重渲染
const EMPTY_EVENTS: SessionEvent[] = [];

function Workspace() {
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
      <SessionTabs project={project} />
      {session ? (
        <ChatView session={session} events={events} />
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

export default function App() {
  const ready = useWorkbench((s) => s.ready);
  const init = useWorkbench((s) => s.init);
  const lastError = useWorkbench((s) => s.lastError);
  const dialogOpen = useWorkbench((s) => s.dialog !== null);
  const clearError = useWorkbench((s) => s.clearError);

  useEffect(() => {
    init();
  }, [init]);

  if (!ready) {
    return (
      <div className="flex h-screen items-center justify-center bg-zinc-950 text-sm text-zinc-600">
        正在启动工作台…
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-zinc-950 text-zinc-200">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        {lastError && !dialogOpen && (
          <div className="flex items-start gap-3 border-b border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-200">
            <p className="min-w-0 flex-1">{lastError}</p>
            <button
              type="button"
              className="shrink-0 text-xs text-red-300 hover:text-white"
              onClick={clearError}
            >
              关闭
            </button>
          </div>
        )}
        <Workspace />
      </main>
      <NewProjectDialog />
      <UpdateDialog />
    </div>
  );
}
