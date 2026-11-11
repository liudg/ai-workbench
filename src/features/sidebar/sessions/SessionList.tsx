import { useState } from "react";

import { cn } from "@/lib/utils";
import { STANDALONE_DRAFT_ID } from "@/store/standalone";
import type { Session } from "@/types";
import { SessionRows } from "./SessionRows";
import { revealMoreSessions, SESSION_PREVIEW_LIMIT, sidebarSessionWindow } from "./session-order";
import { usePinnedSessionIds } from "./use-pinned-session-ids";

const rowButtonClass =
  "w-full rounded-lg py-1 pl-[52px] pr-2 text-left text-[11.5px] text-[var(--wb-faint)] hover:bg-[var(--wb-hover)] hover:text-[var(--wb-text)]";

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
  const showGuide = projectId !== STANDALONE_DRAFT_ID;

  return (
    <div
      className={cn(
        "mt-0.5",
        showGuide &&
          "relative before:pointer-events-none before:absolute before:bottom-1 before:left-[14px] before:top-1 before:w-px before:bg-[var(--wb-border)]",
      )}
    >
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
