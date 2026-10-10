import { useEffect, useState } from "react";

import { isReadOnlyOpen } from "@/lib/utils";
import { useWorkbench } from "@/store";
import type { Session } from "@/types";
import { SessionRow } from "./SessionRow";

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
  const readOnlyKey = useWorkbench((s) => {
    let key = "";
    for (const session of sessions) {
      if (isReadOnlyOpen(s.events[session.id])) key += `${session.id}\n`;
    }
    return key;
  });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const visible = showAll ? sessions : sessions.slice(0, SESSION_PREVIEW_LIMIT);
  const overflow = sessions.length > SESSION_PREVIEW_LIMIT;
  const readOnlyIds = new Set(readOnlyKey ? readOnlyKey.slice(0, -1).split("\n") : []);

  return (
    <div className="mt-0.5 space-y-0.5">
      {visible.map((session) => (
        <SessionRow
          key={session.id}
          projectId={projectId}
          session={session}
          active={selected && session.id === activeSessionId}
          readOnly={readOnlyIds.has(session.id)}
          now={now}
        />
      ))}
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
