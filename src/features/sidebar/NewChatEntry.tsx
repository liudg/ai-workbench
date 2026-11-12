import { SquarePen } from "lucide-react";

import { cn } from "@/lib/utils";
import { useNewChatEntry } from "./use-new-chat-entry";

/** 侧栏顶部的独立对话快捷入口。 */
export function NewChatEntry() {
  const { active, open } = useNewChatEntry();
  return (
    <button
      type="button"
      data-new-chat-entry=""
      aria-label="新建独立对话"
      title="新建独立对话"
      aria-pressed={active}
      className={cn(
        "flex h-7 w-7 items-center justify-center rounded-lg transition-colors",
        active
          ? "bg-wb-active text-wb-fg"
          : "text-wb-fg-2 hover:bg-wb-hover hover:text-wb-fg",
      )}
      onClick={open}
    >
      <SquarePen className="h-3.5 w-3.5" strokeWidth={1.9} />
    </button>
  );
}
