import { useEffect, useState } from "react";

import type { SidebarTask } from "../sidebar-task";
import { SessionRow } from "./SessionRow";
import { useVirtualRows } from "./use-virtual-rows";
import { SESSION_ROW_HEIGHT } from "./virtual-window";

export function SessionRows({
  tasks,
  activeTaskId,
}: {
  tasks: readonly SidebarTask[];
  activeTaskId: string | null;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const { ref, start, end } = useVirtualRows(tasks.length, SESSION_ROW_HEIGHT);
  const rows = tasks.slice(start, end);

  return (
    <div
      ref={ref}
      className="relative overflow-hidden bg-[#141414]"
      style={{ height: tasks.length * SESSION_ROW_HEIGHT }}
    >
      {rows.map((task, index) => (
        <div
          key={task.id}
          style={{ top: (start + index) * SESSION_ROW_HEIGHT, height: SESSION_ROW_HEIGHT }}
          className="absolute inset-x-0 overflow-hidden"
        >
          <SessionRow task={task} active={task.id === activeTaskId} now={now} />
        </div>
      ))}
    </div>
  );
}
