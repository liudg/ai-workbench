import { useWorkbench } from "@/store";
import type { Session } from "@/types";
import { SessionRows } from "./SessionRows";
import { sidebarSessionWindow } from "./session-order";

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
  const pinnedIds = useWorkbench((s) => s.pinnedSessionIds);
  const { visible, overflow } = sidebarSessionWindow(sessions, showAll, pinnedIds);

  return (
    <div className="mt-0.5">
      <SessionRows
        projectId={projectId}
        sessions={visible}
        selected={selected}
        activeSessionId={activeSessionId}
      />
      {overflow && (
        <div className="pt-0.5">
          <button
            type="button"
            className="w-full rounded-md py-1 pl-[58px] pr-2 text-left text-[11.5px] text-[#666] hover:bg-white/[0.04] hover:text-[#bdbdbd]"
            onClick={onToggleShowAll}
          >
            {showAll ? "收起" : "展开显示"}
          </button>
        </div>
      )}
    </div>
  );
}
