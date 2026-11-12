import type { ReactNode } from "react";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";

export function ModeChip({
  id,
  label,
  tooltip,
  dismissLabel,
  icon,
  iconOnly,
  disabled,
  onDismiss,
}: {
  id: "plan" | "goal";
  label: string;
  tooltip: string;
  dismissLabel: string;
  icon: ReactNode;
  iconOnly: boolean;
  disabled: boolean;
  onDismiss: () => void;
}) {
  return (
    <button
      type="button"
      data-mode-chip={id}
      aria-label={dismissLabel}
      disabled={disabled}
      className={cn(
        "group relative inline-flex h-7 shrink-0 items-center gap-1 rounded-lg bg-wb-accent-soft text-[13px] text-wb-accent transition-colors hover:bg-wb-hover hover:text-wb-fg disabled:cursor-not-allowed disabled:opacity-40",
        iconOnly ? "w-7 justify-center px-0" : "px-2",
      )}
      onClick={(event) => {
        event.stopPropagation();
        onDismiss();
      }}
    >
      <span className="inline-flex shrink-0 group-hover:hidden" aria-hidden>{icon}</span>
      <X className="hidden h-3.5 w-3.5 shrink-0 group-hover:block" aria-hidden />
      {iconOnly ? null : <span>{label}</span>}
      <span
        role="tooltip"
        data-mode-tooltip={id}
        className="wb-tooltip pointer-events-none absolute bottom-[calc(100%+6px)] left-1/2 z-30 -translate-x-1/2 whitespace-nowrap rounded-md px-2 py-1 text-xs font-normal opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
      >
        {tooltip}
      </span>
    </button>
  );
}
