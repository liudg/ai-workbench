import { useEffect, useState } from "react";

import type { Session } from "@/types";
import { SessionRow } from "./SessionRow";
import { useReadOnlySessionKey } from "./use-session-list";
import { useVirtualRows } from "./use-virtual-rows";
import { SESSION_ROW_HEIGHT } from "./virtual-window";

export function SessionRows({
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
  const readOnlyKey = useReadOnlySessionKey(sessions);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const { ref, start, end } = useVirtualRows(sessions.length, SESSION_ROW_HEIGHT);
  const rows = sessions.slice(start, end);
  const readOnlyIds = new Set(readOnlyKey ? readOnlyKey.slice(0, -1).split("\n") : []);

  return (
    <div
      ref={ref}
      className="relative bg-transparent"
      style={{ height: sessions.length * SESSION_ROW_HEIGHT }}
    >
      {rows.map((session, index) => (
        <div
          key={session.id}
          style={{ top: (start + index) * SESSION_ROW_HEIGHT, height: SESSION_ROW_HEIGHT }}
          className="absolute inset-x-0"
        >
          <SessionRow
            projectId={session.project_id || projectId}
            session={session}
            active={selected && session.id === activeSessionId}
            readOnly={readOnlyIds.has(session.id)}
            now={now}
          />
        </div>
      ))}
    </div>
  );
}
