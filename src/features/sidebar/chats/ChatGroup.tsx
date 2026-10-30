import { useState } from "react";
import { ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";
import { NewSessionButton } from "../sessions/NewSessionButton";
import { SessionList } from "../sessions/SessionList";
import { partitionSidebarSessions } from "../sessions/session-partition";
import type { SidebarTask } from "../sidebar-task";

/** 不属于任何项目的独立聊天。点标题行收起或展开，和项目分组一样。 */
export function ChatGroup({
  tasks,
  activeTaskId,
}: {
  tasks: readonly SidebarTask[];
  activeTaskId: string | null;
}) {
  const grouped = partitionSidebarSessions(tasks);
  const [collapsed, setCollapsed] = useState(false);

  return (
    <section data-sidebar-section="chats" className="pb-2 pt-2">
      <div
        className="group/chat flex cursor-pointer items-center gap-1.5 rounded-md px-3 pb-1 pt-1 hover:bg-white/[0.04]"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((value) => !value)}
      >
        <ChevronRight
          className={cn("h-3.5 w-3.5 shrink-0 text-[#777] transition-transform", !collapsed && "rotate-90")}
        />
        <span className="flex-1 text-[12px] text-[#cfcfcf]">聊天</span>
        <NewSessionButton
          projectId={null}
          appearance="plus"
          title="新建聊天"
          className="pointer-events-none opacity-0 group-hover/chat:pointer-events-auto group-hover/chat:opacity-100 group-focus-within/chat:pointer-events-auto group-focus-within/chat:opacity-100"
        />
      </div>
      {collapsed ? null : grouped.active.length === 0 ? (
        <p data-empty-chats="" className="px-3 py-1 text-[12px] text-[#666]">
          无聊天
        </p>
      ) : (
        <SessionList tasks={grouped.active} activeTaskId={activeTaskId} />
      )}
    </section>
  );
}
