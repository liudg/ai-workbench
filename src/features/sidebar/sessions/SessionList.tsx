import { useState } from "react";

import type { SidebarTask } from "../sidebar-task";
import { SessionRows } from "./SessionRows";
import { revealMoreSessions, SESSION_PREVIEW_LIMIT, sidebarSessionWindow } from "./session-order";

const rowButtonClass =
  "w-full rounded-md py-1 pl-[58px] pr-2 text-left text-[11.5px] text-[#666] hover:bg-white/[0.04] hover:text-[#bdbdbd]";

export function SessionList({
  tasks,
  activeTaskId,
}: {
  tasks: readonly SidebarTask[];
  activeTaskId: string | null;
}) {
  const [visibleLimit, setVisibleLimit] = useState(SESSION_PREVIEW_LIMIT);
  const pinnedIds = tasks.filter((task) => task.pinned).map((task) => task.id);
  const { visible, canRevealMore, canCollapse } = sidebarSessionWindow(tasks, visibleLimit, pinnedIds);

  return (
    <div className="mt-0.5">
      <SessionRows tasks={visible} activeTaskId={activeTaskId} />
      {(canRevealMore || canCollapse) && (
        <div className="pt-0.5">
          {canRevealMore && (
            <button
              type="button"
              className={rowButtonClass}
              onClick={() => setVisibleLimit((value) => revealMoreSessions(value))}
            >
              展开显示
            </button>
          )}
          {canCollapse && (
            <button
              type="button"
              className={rowButtonClass}
              onClick={() => setVisibleLimit(SESSION_PREVIEW_LIMIT)}
            >
              收起
            </button>
          )}
        </div>
      )}
    </div>
  );
}
