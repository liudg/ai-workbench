import { cn, isReadOnlyOpen } from "@/lib/utils";
import { useWorkbench } from "@/store";
import type { Session } from "@/types";

const SESSION_PREVIEW_LIMIT = 8;

export function SessionList({
  projectId,
  sessions,
  selected,
  activeSessionId,
  showAll,
  onToggleShowAll,
}: {
  projectId: string;
  sessions: Session[];
  selected: boolean;
  activeSessionId: string | undefined;
  showAll: boolean;
  onToggleShowAll: () => void;
}) {
  const events = useWorkbench((s) => s.events);
  const selectSession = useWorkbench((s) => s.selectSession);
  const visible = showAll ? sessions : sessions.slice(0, SESSION_PREVIEW_LIMIT);
  const overflow = sessions.length > SESSION_PREVIEW_LIMIT;

  return (
    <div className="mt-0.5 space-y-0.5">
      {visible.map((session) => {
        const active = selected && session.id === activeSessionId;
        const readOnly = isReadOnlyOpen(events[session.id]);
        return (
          <button
            key={session.id}
            type="button"
            className={cn(
              "flex w-full items-center rounded-md py-1 pl-7 pr-2 text-left text-[13px] leading-5",
              active
                ? "text-zinc-100"
                : "text-zinc-400 hover:bg-zinc-800/40 hover:text-zinc-200",
            )}
            onClick={() => selectSession(projectId, session.id)}
          >
            <span className="min-w-0 flex-1 truncate">{session.title}</span>
            {readOnly && (
              <span className="ml-1 shrink-0 rounded bg-amber-400/15 px-1.5 py-0.5 text-[10px] leading-4 text-amber-200">
                只读
              </span>
            )}
          </button>
        );
      })}
      {overflow && (
        <button
          type="button"
          className="w-full rounded-md py-1 pl-7 pr-2 text-left text-[13px] text-zinc-500 hover:bg-zinc-800/40 hover:text-zinc-200"
          onClick={onToggleShowAll}
        >
          {showAll ? "收起" : "展开显示"}
        </button>
      )}
    </div>
  );
}
