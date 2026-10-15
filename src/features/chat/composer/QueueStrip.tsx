import { useRef, useState } from "react";
import { List, MoreHorizontal, Pencil, Reply, Trash2 } from "lucide-react";

import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import type { QueuedTurn } from "@/types";
import { useComposerMenu } from "./useComposerMenu";
import {
  focusedQueueItem,
  queueMenuItems,
  queuePreviewText,
  queueStripIntent,
  type QueueMenuEntry,
} from "./queue-strip";

const REMOVE_LABEL = "删除排队消息";
const MORE_LABEL = "更多";

export function QueueStrip({
  items,
  index,
  editingId,
  defaultMenuOpen = false,
  onCycle,
  onSteer,
  onRemove,
  onEdit,
  onCloseQueue,
}: {
  items: QueuedTurn[];
  index: number;
  editingId: string | null;
  defaultMenuOpen?: boolean;
  onCycle: () => void;
  onSteer: (id: string) => void;
  onRemove: (id: string) => void;
  onEdit: (item: QueuedTurn) => void;
  onCloseQueue: () => void;
}) {
  const focused = focusedQueueItem(items, index);
  const [open, setOpen] = useState(defaultMenuOpen);
  const moreRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useComposerMenu(open, moreRef, menuRef, () => setOpen(false));
  if (!focused) return null;
  const preview = queuePreviewText(focused);
  // 工作台没有侧边聊天，所以没有「在侧边聊天中打开」。
  // TODO(codex-parity): 对照本机 Codex 桌面核对图标、间距和多条聚焦。
  const menu = queueMenuItems(false);
  const count = (
    <>
      <List className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
      <span className="min-w-[0.75rem] text-left text-[13px] tabular-nums text-[#e8e8e8]" data-queue-count>
        {items.length}
      </span>
    </>
  );

  const run = (action: "steer" | "remove" | "edit" | "close") => {
    const intent = queueStripIntent(action, focused);
    if (!intent) return;
    if (intent.type === "steer") onSteer(intent.id);
    else if (intent.type === "remove") onRemove(intent.id);
    else if (intent.type === "edit") onEdit(focused);
    else onCloseQueue();
  };

  const pickMenu = (entry: QueueMenuEntry) => {
    setOpen(false);
    if (entry.id === "edit") run("edit");
    else if (entry.id === "close") run("close");
  };

  return (
    <div
      data-queue-strip
      data-editing={editingId === focused.id ? "true" : "false"}
      className="flex min-w-0 items-center gap-1 border-b border-[#2a2a2a] py-1 pl-2.5 pr-1.5"
      onClick={(event) => event.stopPropagation()}
    >
      {items.length > 1 ? (
        <button
          type="button"
          data-queue-cycle
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-1 text-[#a3a3a3] hover:bg-zinc-800 hover:text-[#e8e8e8]"
          aria-label="下一条排队消息"
          onClick={onCycle}
        >
          {count}
        </button>
      ) : (
        <span className="inline-flex h-7 shrink-0 items-center gap-1.5 px-1 text-[#a3a3a3]" aria-label="排队">
          {count}
        </span>
      )}
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
          onClick={() => run("steer")}
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
          onClick={() => run("remove")}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
        <button
          ref={moreRef}
          type="button"
          data-queue-more
          className="flex h-7 w-7 items-center justify-center rounded-md text-[#a3a3a3] hover:bg-zinc-800 hover:text-[#e8e8e8]"
          aria-label={MORE_LABEL}
          title={MORE_LABEL}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </div>
      {open ? (
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
