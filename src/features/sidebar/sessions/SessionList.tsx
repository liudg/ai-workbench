import { useEffect, useState } from "react";

import type { Session } from "@/types";
import { SessionRow } from "./SessionRow";
import { sidebarSessionWindow } from "./session-order";
import { useReadOnlySessionKey } from "./use-session-list";
import { useVirtualRows } from "./use-virtual-rows";
import { SESSION_ROW_HEIGHT } from "./virtual-window";

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
  const readOnlyKey = useReadOnlySessionKey(sessions);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const { visible, overflow } = sidebarSessionWindow(sessions, showAll);
  const { ref, start, end } = useVirtualRows(visible.length, SESSION_ROW_HEIGHT);
  const rows = visible.slice(start, end);
  const readOnlyIds = new Set(readOnlyKey ? readOnlyKey.slice(0, -1).split("\n") : []);

  return (
    <div className="mt-0.5">
      <div
        ref={ref}
        className="relative overflow-hidden bg-[#141414]"
        style={{ height: visible.length * SESSION_ROW_HEIGHT }}
      >
        {rows.map((session, index) => (
          <div
            key={session.id}
            style={{ top: (start + index) * SESSION_ROW_HEIGHT, height: SESSION_ROW_HEIGHT }}
            className="absolute inset-x-0 overflow-hidden"
          >
            <SessionRow
              projectId={projectId}
              session={session}
              active={selected && session.id === activeSessionId}
              readOnly={readOnlyIds.has(session.id)}
              now={now}
            />
          </div>
        ))}
      </div>
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
