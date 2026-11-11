import { Lightbulb, X } from "lucide-react";

import { Tooltip } from "@/components/ui/tooltip";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";

/** 作曲栏页脚上的计划标识。点一下退出计划模式。 */
export function PlanModeIndicator({
  disabled,
  onExit,
}: {
  disabled: boolean;
  onExit: () => void;
}) {
  return (
    <Tooltip label={DESKTOP_ZH.planTooltip} side="top" className="shrink-0">
      <button
        type="button"
        data-plan-indicator
        aria-label={DESKTOP_ZH.planLabel}
        disabled={disabled}
        className="group inline-flex h-8 shrink-0 items-center gap-1 rounded-full px-2 text-sm text-[var(--wb-muted)] transition-colors hover:bg-[var(--wb-hover)] hover:text-[var(--wb-text-strong)] disabled:cursor-not-allowed disabled:opacity-40"
        onClick={(event) => {
          event.stopPropagation();
          onExit();
        }}
      >
        <Lightbulb className="h-3.5 w-3.5 shrink-0 group-hover:hidden" aria-hidden />
        <X className="hidden h-3.5 w-3.5 shrink-0 group-hover:block" aria-hidden />
        <span>{DESKTOP_ZH.planLabel}</span>
      </button>
    </Tooltip>
  );
}
