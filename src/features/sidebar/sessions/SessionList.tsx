import { useState } from "react";

import type { SidebarTask } from "../sidebar-task";
import { SessionRows } from "./SessionRows";
import { nestLines, splitSubtasks } from "./session-nesting";
import { revealMoreSessions, SESSION_PREVIEW_LIMIT, sidebarSessionWindow } from "./session-order";

const rowButtonClass =
  "w-full rounded-lg py-1 pl-[52px] pr-2 text-left text-xs text-wb-fg-3 hover:bg-wb-hover hover:text-wb-fg-2";

export function SessionList({
  tasks,
  activeTaskId,
}: {
  tasks: readonly SidebarTask[];
  activeTaskId: string | null;
}) {
  const [visibleLimit, setVisibleLimit] = useState(SESSION_PREVIEW_LIMIT);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const { roots, childrenOf } = splitSubtasks(tasks);
  const pinnedIds = roots.filter((task) => task.pinned).map((task) => task.id);
  const { visible, canRevealMore, canCollapse } = sidebarSessionWindow(roots, visibleLimit, pinnedIds);
  const toggle = (id: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <div className="mt-0.5">
      <SessionRows lines={nestLines(visible, childrenOf, collapsed)} activeTaskId={activeTaskId} onToggle={toggle} />
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
