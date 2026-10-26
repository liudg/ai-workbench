import { NewSessionButton } from "../sessions/NewSessionButton";
import { SessionList } from "../sessions/SessionList";
import { partitionSidebarSessions } from "../sessions/session-partition";
import type { SidebarTask } from "../sidebar-task";

/** 不属于任何项目的独立聊天。 */
export function ChatGroup({
  tasks,
  activeTaskId,
}: {
  tasks: readonly SidebarTask[];
  activeTaskId: string | null;
}) {
  const grouped = partitionSidebarSessions(tasks);

  return (
    <section data-sidebar-section="chats" className="pb-2 pt-2">
      <div className="group/chat flex items-center justify-between px-3 pb-1 pt-1">
        <span className="text-[12px] text-[#cfcfcf]">聊天</span>
        <NewSessionButton
          projectId={null}
          appearance="plus"
          title="新建聊天"
          className="pointer-events-none opacity-0 group-hover/chat:pointer-events-auto group-hover/chat:opacity-100 group-focus-within/chat:pointer-events-auto group-focus-within/chat:opacity-100"
        />
      </div>
      {grouped.active.length === 0 ? (
        <p data-empty-chats="" className="px-3 py-1 text-[12px] text-[#666]">
          无聊天
        </p>
      ) : (
        <SessionList tasks={grouped.active} activeTaskId={activeTaskId} />
      )}
    </section>
  );
}
