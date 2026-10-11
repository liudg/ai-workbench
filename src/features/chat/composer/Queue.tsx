import { Pencil, Trash2 } from "lucide-react";

import { cn } from "@/lib/utils";
import type { QueuedTurn } from "@/types";
import { ChatThumb } from "../answer/ChatThumb";
import { fileName } from "./media";

export function Queue({
  items,
  editingId,
  onEdit,
  onRemove,
}: {
  items: QueuedTurn[];
  editingId: string | null;
  onEdit: (item: QueuedTurn) => void;
  onRemove: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="mb-2 flex min-w-0 flex-col gap-1.5 overflow-x-hidden">
      {items.map((item) => (
        <div
          key={item.id}
          className={cn(
            "flex min-w-0 items-start gap-2 overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/80 px-3 py-2",
            editingId === item.id && "border-indigo-400/80",
          )}
        >
          <div className="min-w-0 flex-1">
            {item.text && (
              <p className="line-clamp-3 whitespace-pre-wrap break-words text-sm leading-5 text-zinc-200">{item.text}</p>
            )}
            {(item.images ?? []).length > 0 && (
              <div className="mt-1 flex min-w-0 flex-wrap gap-1 overflow-x-hidden">
                {(item.images ?? []).map((path) => (
                  <ChatThumb key={path} path={path} name={fileName(path)} className="h-10 w-10 rounded-md object-cover" />
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            className="rounded-full p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
            aria-label="编辑排队消息"
            onClick={(event) => {
              event.stopPropagation();
              onEdit(item);
            }}
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className="rounded-full p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
            aria-label="删除排队消息"
            onClick={(event) => {
              event.stopPropagation();
              onRemove(item.id);
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
