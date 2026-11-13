import { SquarePen } from "lucide-react";

import { cn } from "@/lib/utils";
import { useNewChatEntry } from "./use-new-chat-entry";

/** 侧栏顶部的新建聊天导航行。 */
export function NewChatEntry() {
  const { active, open } = useNewChatEntry();
  return (
    <button
      type="button"
      data-new-chat-entry=""
      aria-pressed={active}
      className={cn(
        "flex h-8 w-full items-center gap-2.5 rounded-lg px-2 text-left text-[13px] transition-colors",
        active
          ? "bg-wb-active font-medium text-wb-fg"
          : "text-wb-fg-2 hover:bg-wb-hover hover:text-wb-fg",
      )}
      onClick={open}
    >
      <SquarePen className="h-3.5 w-3.5 shrink-0 text-wb-fg-3" strokeWidth={1.8} />
      <span className="flex-1 truncate">新建对话</span>
    </button>
  );
}
