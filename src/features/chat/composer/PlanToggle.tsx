import { cn } from "@/lib/utils";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";

export function PlanToggle({
  pressed,
  disabled,
  onToggle,
}: {
  pressed: boolean;
  disabled: boolean;
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
        "inline-flex h-8 shrink-0 items-center rounded-full px-2.5 text-sm disabled:cursor-not-allowed disabled:opacity-40",
        pressed ? "bg-zinc-100 text-zinc-950" : "text-zinc-300 hover:bg-zinc-800",
      )}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      {DESKTOP_ZH.planLabel}
    </button>
  );
}
