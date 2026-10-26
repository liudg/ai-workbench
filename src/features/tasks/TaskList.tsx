import { GitBranch, Trash2 } from "lucide-react";

import { cn } from "@/lib/utils";
import type { SessionStatus } from "@/types";
import type { TaskEntry } from "./types";

/** 只有需要看一眼的状态才画：在跑、等你、出错。 */
function StatusDot({ status }: { status: SessionStatus | undefined }) {
  if (status === "running") {
    return <span data-task-status={status} className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-sky-400" />;
  }
  if (status === "needs-input") {
    return <span data-task-status={status} className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />;
  }
  if (status === "failed") {
    return <span data-task-status={status} className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-400" />;
  }
  return <span className="h-1.5 w-1.5 shrink-0" />;
}

export function TaskList({
  tasks,
  selectedId,
  onSelect,
  onRemove,
}: {
  tasks: TaskEntry[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRemove: (task: TaskEntry) => void;
}) {
  if (tasks.length === 0) return null;
  return (
    <ul className="pb-1">
      {tasks.map((task) => {
        const status = task.sessions[0]?.status;
        const title = task.title.trim() || "新任务";
        return (
          <li key={task.id}>
            <div
              role="button"
              tabIndex={0}
              title={title}
              aria-current={task.id === selectedId ? "true" : undefined}
              className={cn(
                "group mx-1 flex cursor-pointer items-center gap-2 rounded-md py-1.5 pl-6 pr-2 text-[12.5px] transition-colors hover:bg-white/[0.04]",
                task.id === selectedId && "bg-white/[0.07]",
              )}
              onClick={() => onSelect(task.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(task.id);
                }
              }}
            >
              <StatusDot status={status} />
              <span className="min-w-0 flex-1 truncate text-[#d8d8d8]">{title}</span>
              {task.workspace.kind === "worktree" && (
                <GitBranch className="h-3 w-3 shrink-0 text-[#666]" aria-label={task.workspace.branch} />
              )}
              <button
                type="button"
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[#777] opacity-0 transition-opacity hover:bg-white/10 hover:text-[#e8e8e8] focus:opacity-100 group-hover:opacity-100"
                aria-label={`删除任务 ${title}`}
                title="删除任务"
                onClick={(event) => {
                  event.stopPropagation();
                  onRemove(task);
                }}
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
