import type { MouseEvent as ReactMouseEvent, Ref } from "react";
import { Plus } from "lucide-react";

import { cn } from "@/lib/utils";

/** 项目标头和聊天标头共用的 +。 */
export function SidebarPlusButton({
  label,
  title,
  className,
  buttonRef,
  expanded,
  hasPopup,
  onClick,
}: {
  label: string;
  title?: string;
  className?: string;
  buttonRef?: Ref<HTMLButtonElement>;
  expanded?: boolean;
  hasPopup?: boolean;
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className={cn(
        "flex h-6 w-6 items-center justify-center rounded-md text-wb-fg-3 transition-colors hover:bg-wb-hover hover:text-wb-fg",
        className,
      )}
      aria-label={label}
      aria-haspopup={hasPopup ? "menu" : undefined}
      aria-expanded={expanded}
      title={title ?? label}
      onClick={onClick}
    >
      <Plus className="h-4 w-4" strokeWidth={2} />
    </button>
  );
}
