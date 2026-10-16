import { useState } from "react";

import type { Session } from "@/types";
import { SessionRows } from "./SessionRows";
import { revealMoreSessions, SESSION_PREVIEW_LIMIT, sidebarSessionWindow } from "./session-order";
import { usePinnedSessionIds } from "./use-pinned-session-ids";

const rowButtonClass =
  "w-full rounded-md py-1 pl-[58px] pr-2 text-left text-[11.5px] text-[#666] hover:bg-white/[0.04] hover:text-[#bdbdbd]";

export function SessionList({
  projectId,
  sessions,
  selected,
  activeSessionId,
}: {
  projectId: string;
  sessions: Session[];
  selected: boolean;
  activeSessionId: string | undefined;
}) {
  const pinnedIds = usePinnedSessionIds();
  const [visibleLimit, setVisibleLimit] = useState(SESSION_PREVIEW_LIMIT);
  const { visible, canRevealMore, canCollapse } = sidebarSessionWindow(
    sessions,
    visibleLimit,
    pinnedIds,
  );

  return (
    <div className="mt-0.5">
      <SessionRows
        projectId={projectId}
        sessions={visible}
        selected={selected}
        activeSessionId={activeSessionId}
      />
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
