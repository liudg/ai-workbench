import type { ReactNode } from "react";
import { X } from "lucide-react";

import { Tooltip } from "@/components/ui/tooltip";
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
    <Tooltip label={tooltip} side="top" className="shrink-0">
      <button
        type="button"
        data-mode-chip={id}
        aria-label={dismissLabel}
        disabled={disabled}
        className={cn(
          "inline-flex h-8 shrink-0 items-center gap-1 rounded-full bg-[var(--wb-send-bg)] text-sm text-[var(--wb-send-fg)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40",
          iconOnly ? "w-8 justify-center px-0" : "px-2.5",
        )}
        onClick={(event) => {
          event.stopPropagation();
          onDismiss();
        }}
      >
        {icon}
        {iconOnly ? null : <span>{label}</span>}
        <X className="h-3 w-3 shrink-0" aria-hidden />
      </button>
    </Tooltip>
  );
}
