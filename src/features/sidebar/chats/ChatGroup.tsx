import { useState } from "react";
import { ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";
import { NewSessionButton } from "../sessions/NewSessionButton";
import { SessionList } from "../sessions/SessionList";
import { partitionSidebarSessions } from "../sessions/session-partition";
import type { SidebarTask } from "../sidebar-task";

/** 不属于任何项目的独立对话。没有独立对话时不展示空占位，避免侧栏重复噪音。 */
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
        className="group/chat flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1 transition-colors hover:bg-wb-hover"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((value) => !value)}
      >
        <ChevronRight
          className={cn("h-3.5 w-3.5 shrink-0 text-wb-fg-3 transition-transform", !collapsed && "rotate-90")}
        />
        <span className="flex-1 text-[11px] font-medium tracking-wide text-wb-fg-3">独立对话</span>
        <NewSessionButton
          projectId={null}
          appearance="plus"
          title="新建对话"
          className="pointer-events-none opacity-0 group-hover/chat:pointer-events-auto group-hover/chat:opacity-100 group-focus-within/chat:pointer-events-auto group-focus-within/chat:opacity-100"
        />
      </div>
      {collapsed ? null : <SessionList tasks={grouped.active} activeTaskId={activeTaskId} />}
    </section>
  );
}
