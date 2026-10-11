import { ListChecks } from "lucide-react";

import { cn } from "@/lib/utils";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";

export function PlanToggle({
  pressed,
  disabled,
  iconOnly,
  onToggle,
}: {
  pressed: boolean;
  disabled: boolean;
  iconOnly: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={DESKTOP_ZH.planLabel}
      title={DESKTOP_ZH.planTooltip}
      disabled={disabled}
      className={cn(
        "inline-flex h-8 shrink-0 items-center justify-center rounded-full text-sm disabled:cursor-not-allowed disabled:opacity-40",
        iconOnly ? "w-8" : "px-2.5",
        pressed ? "bg-zinc-100 text-zinc-950" : "text-zinc-300 hover:bg-zinc-800",
      )}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      {iconOnly ? <ListChecks className="h-4 w-4" /> : DESKTOP_ZH.planLabel}
    </button>
  );
}
