import { useEffect } from "react";
import { Square } from "lucide-react";

import { ChatView } from "@/components/ChatView";
import { NoProjectSelected, NoSession } from "@/components/EmptyState";
import { NewProjectDialog } from "@/components/NewProjectDialog";
import { SessionTabs } from "@/components/SessionTabs";
import { Sidebar } from "@/components/Sidebar";
import { StatusDot } from "@/components/StatusDot";
import { UpdateDialog } from "@/components/UpdateDialog";
import { Button } from "@/components/ui/button";
import { useWorkbench } from "@/store";
import { AGENT_LABELS, STATUS_LABELS, type SessionEvent } from "@/types";

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
  const stopSession = useWorkbench((s) => s.stopSession);

  if (!project) return <NoProjectSelected />;

  return (
    <div className="relative flex h-full min-w-0 flex-1 flex-col">
      <SessionTabs project={project} />
      {session ? (
        <>
          <div className="flex shrink-0 items-center gap-3 border-b border-zinc-800/60 bg-zinc-900/10 px-6 py-2">
            <StatusDot status={session.status} />
            <span className="text-xs text-zinc-400">
              {STATUS_LABELS[session.status]}
            </span>
            <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-400">
              {AGENT_LABELS[session.agent]}
            </span>
            <span
              className="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-600"
              title={project.path}
            >
              {project.path}
            </span>
            {(session.status === "running" ||
              session.status === "needs-input") && (
              <Button
                variant="ghost"
                size="sm"
                className="text-red-400 hover:text-red-300"
                onClick={() => stopSession(session.id)}
              >
                <Square className="h-3 w-3" fill="currentColor" /> 停止会话
              </Button>
            )}
          </div>
          <ChatView session={session} events={events} />
        </>
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
        <Workspace />
      </main>
      <NewProjectDialog />
      <UpdateDialog />
    </div>
  );
}
