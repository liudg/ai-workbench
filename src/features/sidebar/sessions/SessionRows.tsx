import { useEffect, useState } from "react";

import type { SidebarTask } from "../sidebar-task";
import { SessionRow } from "./SessionRow";
import type { SessionLine } from "./session-nesting";
import { useVirtualRows } from "./use-virtual-rows";
import { SESSION_ROW_HEIGHT } from "./virtual-window";

export function SessionRows({
  lines,
  activeTaskId,
  onToggle,
}: {
  lines: readonly SessionLine<SidebarTask>[];
  activeTaskId: string | null;
  /** 折叠或展开父任务下的子任务。 */
  onToggle: (taskId: string) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const { ref, start, end } = useVirtualRows(lines.length, SESSION_ROW_HEIGHT);
  const rows = lines.slice(start, end);

  return (
    <div
      ref={ref}
      className="relative overflow-hidden bg-[#141414]"
      style={{ height: lines.length * SESSION_ROW_HEIGHT }}
    >
      {rows.map((line, index) => (
        <div
          key={line.task.id}
          style={{ top: (start + index) * SESSION_ROW_HEIGHT, height: SESSION_ROW_HEIGHT }}
          className="absolute inset-x-0 overflow-hidden"
        >
          <SessionRow
            task={line.task}
            active={line.task.id === activeTaskId}
            now={now}
            depth={line.depth}
            subtasks={line.subtasks}
            collapsed={line.collapsed}
            onToggle={() => onToggle(line.task.id)}
          />
        </div>
      ))}
    </div>
  );
}
