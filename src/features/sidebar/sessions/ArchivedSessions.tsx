import { useState } from "react";

import type { Session } from "@/types";
import { SessionRows } from "./SessionRows";
import { sidebarSessionWindow } from "./session-order";
import { usePinnedSessionIds } from "./use-pinned-session-ids";

export function ArchivedSessions({
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
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const pinnedIds = usePinnedSessionIds();
  if (sessions.length === 0) return null;
  const { visible, overflow } = sidebarSessionWindow(sessions, showAll, pinnedIds);

  return (
    <div className="pt-0.5" data-archived-sessions="">
      <button
        type="button"
        className="w-full rounded-md py-1 pl-[58px] pr-2 text-left text-[11.5px] text-[#666] hover:bg-white/[0.04] hover:text-[#bdbdbd]"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        已归档
      </button>
      {open && (
        <>
          <SessionRows
            projectId={projectId}
            sessions={visible}
            selected={selected}
            activeSessionId={activeSessionId}
          />
          {overflow && (
            <button
              type="button"
              className="w-full rounded-md py-1 pl-[58px] pr-2 text-left text-[11.5px] text-[#666] hover:bg-white/[0.04] hover:text-[#bdbdbd]"
              onClick={() => setShowAll((value) => !value)}
            >
              {showAll ? "收起" : "展开显示"}
            </button>
          )}
        </>
      )}
    </div>
  );
}
