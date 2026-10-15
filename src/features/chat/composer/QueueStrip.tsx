import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { MoreHorizontal, Pencil, Reply, Trash2 } from "lucide-react";

import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import type { QueuedTurn } from "@/types";
import type { FollowUpQueueMode } from "./follow-up-queue-mode";
import { useComposerMenu } from "./useComposerMenu";
import { queueMenuItems, queueRows, type QueueMenuEntry } from "./queue-strip";

const REMOVE_LABEL = "删除排队消息";
const MORE_LABEL = "更多";

/**
 * 排队列表在输入框上方，一行一条。
 * 适配器还没有 `thread/queue/reorder`，所以没有拖动手柄。
 * 工作台没有侧边聊天，也没有中断队列的「继续」。
 */
export function QueuedMessageList({
  items,
  mode,
  editingId,
  canOpenSideChat = false,
  onOpenSideChat,
  defaultMenuOpen = false,
  onSteer,
  onRemove,
  onEdit,
  onToggleQueueMode,
}: {
  items: QueuedTurn[];
  mode: FollowUpQueueMode;
  editingId: string | null;
  canOpenSideChat?: boolean;
  onOpenSideChat?: (item: QueuedTurn) => void;
  defaultMenuOpen?: boolean;
  onSteer: (id: string) => void;
  onRemove: (id: string) => void;
  onEdit: (item: QueuedTurn) => void;
  onToggleQueueMode: () => void;
}) {
  const rows = queueRows(items);
  const sideChat = Boolean(canOpenSideChat && onOpenSideChat);
  const menu = queueMenuItems({ canOpenSideChat: sideChat, mode });
  const [openId, setOpenId] = useState<string | null>(() =>
    defaultMenuOpen ? (items[0]?.id ?? null) : null,
  );
  const moreRefs = useRef(new Map<string, HTMLButtonElement>());
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback(() => setOpenId(null), []);
  const openItem = items.find((item) => item.id === openId) ?? null;

  useLayoutEffect(() => {
    anchorRef.current = openId ? (moreRefs.current.get(openId) ?? null) : null;
  }, [openId, items]);
  useComposerMenu(Boolean(openItem), anchorRef, menuRef, closeMenu, openId);

  if (rows.length === 0) return null;

  const pickMenu = (entry: QueueMenuEntry) => {
    const item = openItem;
    setOpenId(null);
    if (!item) return;
    if (entry.id === "edit") onEdit(item);
    else if (entry.id === "side-chat") onOpenSideChat?.(item);
    else onToggleQueueMode();
  };

  return (
    <div
      data-queue-list
      data-queue-strip
      data-queue-mode={mode}
      className="border-b border-[#2a2a2a]"
      onClick={(event) => event.stopPropagation()}
    >
      {rows.map((row, index) => {
        const item = items.find((candidate) => candidate.id === row.id);
        if (!item) return null;
        const preview = row.preview;
        return (
          <div
            key={row.id}
            data-queue-row
            data-queue-id={row.id}
            data-editing={editingId === row.id ? "true" : "false"}
            className={
              index > 0
                ? "flex min-w-0 items-center gap-1 border-t border-[#2a2a2a] py-0.5 pl-1.5 pr-1"
                : "flex min-w-0 items-center gap-1 py-0.5 pl-1.5 pr-1"
            }
          >
            <span
              data-queue-position
              className="inline-flex h-7 w-5 shrink-0 items-center justify-center text-[12px] tabular-nums text-[#8d8d8d]"
              aria-label={`第${row.position}条`}
            >
              {row.position}
            </span>
            <p
              data-queue-text
              title={preview}
              className="min-w-0 flex-1 truncate px-1 text-[13px] leading-5 text-[#cfcfcf]"
            >
              {preview}
            </p>
            <div className="flex shrink-0 items-center">
              <button
                type="button"
                data-queue-steer
                className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-[13px] text-[#e8e8e8] hover:bg-zinc-800"
                aria-label={DESKTOP_ZH.queueSteer}
                title={DESKTOP_ZH.queueSteerHint}
                onClick={() => onSteer(item.id)}
              >
                <Reply className="h-3.5 w-3.5" aria-hidden />
                {DESKTOP_ZH.queueSteer}
              </button>
              <button
                type="button"
                data-queue-remove
                className="flex h-7 w-7 items-center justify-center rounded-md text-[#a3a3a3] hover:bg-zinc-800 hover:text-[#e8e8e8]"
                aria-label={REMOVE_LABEL}
                title={REMOVE_LABEL}
                onClick={() => onRemove(item.id)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
              <button
                ref={(node) => {
                  if (node) moreRefs.current.set(item.id, node);
                  else moreRefs.current.delete(item.id);
                }}
                type="button"
                data-queue-more
                className="flex h-7 w-7 items-center justify-center rounded-md text-[#a3a3a3] hover:bg-zinc-800 hover:text-[#e8e8e8]"
                aria-label={MORE_LABEL}
                title={MORE_LABEL}
                aria-haspopup="menu"
                aria-expanded={openId === item.id}
                onClick={() => setOpenId((current) => (current === item.id ? null : item.id))}
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
            </div>
          </div>
        );
      })}
      {openItem ? (
        <div
          ref={menuRef}
          role="menu"
          aria-label="排队消息"
          data-queue-menu
          className="fixed z-50 w-max min-w-[9.5rem] overflow-hidden rounded-xl border border-zinc-700/80 bg-zinc-900 py-1 shadow-xl shadow-black/50"
          style={{ top: -9999, left: 8 }}
        >
          {menu.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="menuitem"
              data-queue-action={entry.id}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-zinc-100 hover:bg-zinc-800"
              onClick={() => pickMenu(entry)}
            >
              {entry.id === "edit" ? (
                <Pencil className="h-3.5 w-3.5 shrink-0 text-zinc-400" aria-hidden />
              ) : (
                <span className="h-3.5 w-3.5 shrink-0" aria-hidden />
              )}
              {entry.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
