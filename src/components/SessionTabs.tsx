import { Square } from "lucide-react";

import { cn } from "@/lib/utils";
import { useWorkbench } from "@/store";
import { type Project, type Session } from "@/types";
import { NewSessionButton } from "./NewSessionButton";
import { StatusDot } from "./StatusDot";

function SessionTab({
  session,
  active,
  onSelect,
}: {
  session: Session;
  active: boolean;
  onSelect: () => void;
}) {
  const stopSession = useWorkbench((s) => s.stopSession);
  const stoppable =
    session.status === "running" || session.status === "needs-input";

  return (
    <div
      onClick={onSelect}
      className={cn(
        "group flex h-9 shrink-0 cursor-pointer items-center gap-2 rounded-t-lg border-b-2 px-3 text-sm transition-colors",
        active
          ? "border-indigo-400 bg-zinc-900 text-zinc-100"
          : "border-transparent text-zinc-500 hover:bg-zinc-900/60 hover:text-zinc-300",
      )}
    >
      <StatusDot status={session.status} />
      <span className="max-w-40 truncate">{session.title}</span>
      {stoppable && (
        <button
          title="停止会话"
          className="rounded p-0.5 text-zinc-500 opacity-0 transition-opacity hover:bg-zinc-700 hover:text-red-400 group-hover:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            stopSession(session.id);
          }}
        >
          <Square className="h-3 w-3" fill="currentColor" />
        </button>
      )}
    </div>
  );
}

export function SessionTabs({ project }: { project: Project }) {
  const sessions = useWorkbench((s) => s.sessions[project.id]);
  const activeId = useWorkbench((s) => s.activeSessionId[project.id]);
  const selectSession = useWorkbench((s) => s.selectSession);

  return (
    <div className="flex h-12 shrink-0 items-end gap-1 overflow-x-auto border-b border-zinc-800/80 bg-zinc-900/20 px-3 pt-3">
      {sessions?.map((session) => (
        <SessionTab
          key={session.id}
          session={session}
          active={session.id === activeId}
          onSelect={() => selectSession(project.id, session.id)}
        />
      ))}
      <NewSessionButton
        projectId={project.id}
        appearance="plus"
        className="mb-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
        title="新建会话"
      />
    </div>
  );
}
