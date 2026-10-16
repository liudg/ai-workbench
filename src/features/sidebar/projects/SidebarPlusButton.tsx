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
        "flex h-7 w-7 items-center justify-center rounded-md text-[#888] transition-colors hover:bg-white/5 hover:text-[#e8e8e8]",
        className,
      )}
      aria-label={label}
      aria-haspopup={hasPopup ? "menu" : undefined}
      aria-expanded={expanded}
      title={title ?? label}
      onClick={onClick}
    >
      <Plus className="h-[18px] w-[18px]" strokeWidth={2} />
    </button>
  );
}
