import { useState } from "react";
import { ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";
import { NewSessionButton } from "../sessions/NewSessionButton";
import { SessionList } from "../sessions/SessionList";
import { partitionSidebarSessions } from "../sessions/session-partition";
import type { SidebarTask } from "../sidebar-task";

/** 不属于任何项目的聊天。没有聊天时不展示空占位，避免侧栏重复噪音。 */
export function ChatGroup({
  tasks,
  activeTaskId,
}: {
  tasks: readonly SidebarTask[];
  activeTaskId: string | null;
}) {
  const grouped = partitionSidebarSessions(tasks);
  const [collapsed, setCollapsed] = useState(false);

  if (grouped.active.length === 0) return null;

  return (
    <section data-sidebar-section="chats" className="pb-2 pt-3">
      <div
        role="button"
        tabIndex={0}
        className="group/chat flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1 transition-colors hover:bg-wb-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-wb-accent/60"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((value) => !value)}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setCollapsed((value) => !value);
          }
        }}
      >
        <ChevronRight
          className={cn("h-3.5 w-3.5 shrink-0 text-wb-fg-3 transition-transform", !collapsed && "rotate-90")}
        />
        <span className="wb-group-header min-w-0 flex-1">聊天</span>
        <NewSessionButton
          projectId={null}
          appearance="plus"
          title="新聊天"
          className="pointer-events-none opacity-0 group-hover/chat:pointer-events-auto group-hover/chat:opacity-100 group-focus-within/chat:pointer-events-auto group-focus-within/chat:opacity-100"
        />
      </div>
      {collapsed ? null : <SessionList tasks={grouped.active} activeTaskId={activeTaskId} />}
    </section>
  );
}
