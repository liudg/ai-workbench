import { STANDALONE_DRAFT_ID } from "@/store/standalone";
import { NewSessionButton } from "../sessions/NewSessionButton";
import { SessionList } from "../sessions/SessionList";
import { partitionSidebarSessions } from "../sessions/session-partition";
import { useChatGroup } from "./use-chat-group";

export function ChatGroup() {
  const { chats, pending, activeId } = useChatGroup();
  const items = pending ? [pending, ...chats] : chats;
  const grouped = partitionSidebarSessions(items);
  const empty = grouped.active.length === 0;

  return (
    <section data-sidebar-section="chats" className="pb-2 pt-2">
      <div className="group/chat flex items-center justify-between px-2.5 pb-1 pt-1">
        <span className="text-[11px] font-semibold tracking-[0.04em] text-[var(--wb-faint)]">聊天</span>
        <NewSessionButton
          projectId={STANDALONE_DRAFT_ID}
          appearance="plus"
          title="新建聊天"
          className="pointer-events-none opacity-0 group-hover/chat:pointer-events-auto group-hover/chat:opacity-100 group-focus-within/chat:pointer-events-auto group-focus-within/chat:opacity-100"
        />
      </div>
      {empty ? (
        <p data-empty-chats="" className="px-2.5 py-1 text-[12px] text-[var(--wb-faint)]">
          无聊天
        </p>
      ) : (
        <SessionList
          projectId={STANDALONE_DRAFT_ID}
          sessions={grouped.active}
          selected={Boolean(activeId)}
          activeSessionId={activeId}
        />
      )}
    </section>
  );
}
