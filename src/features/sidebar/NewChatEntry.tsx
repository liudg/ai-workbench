import { SquarePen } from "lucide-react";

import { cn } from "@/lib/utils";
import { useNewChatEntry } from "./use-new-chat-entry";

/** 看板下面的新聊天入口，和「聊天」分组的 + 一样开一个独立聊天。 */
export function NewChatEntry() {
  const { active, open } = useNewChatEntry();
  return (
    <div className="px-2 pt-0.5">
      <button
        type="button"
        data-new-chat-entry=""
        aria-pressed={active}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px]",
          active ? "bg-[#222] text-[#f3f3f3]" : "text-[#cfcfcf] hover:bg-white/[0.04]",
        )}
        onClick={open}
      >
        <SquarePen className="h-3.5 w-3.5 shrink-0 text-[#8a8a8a]" />
        <span className="flex-1">新聊天</span>
      </button>
    </div>
  );
}
