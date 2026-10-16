import { Lightbulb, X } from "lucide-react";

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
    <button
      type="button"
      data-plan-indicator
      aria-label={DESKTOP_ZH.planLabel}
      disabled={disabled}
      className="group relative inline-flex h-8 shrink-0 items-center gap-1 rounded-full px-2 text-sm text-[#cfcfcf] hover:bg-zinc-800 hover:text-zinc-50 disabled:cursor-not-allowed disabled:opacity-40"
      onClick={(event) => {
        event.stopPropagation();
        onExit();
      }}
    >
      <Lightbulb className="h-3.5 w-3.5 shrink-0 group-hover:hidden" aria-hidden />
      <X className="hidden h-3.5 w-3.5 shrink-0 group-hover:block" aria-hidden />
      <span>{DESKTOP_ZH.planLabel}</span>
      <span
        role="tooltip"
        data-plan-indicator-tooltip
        className="pointer-events-none absolute bottom-[calc(100%+6px)] left-1/2 z-30 -translate-x-1/2 whitespace-nowrap rounded-md bg-zinc-950 px-2 py-1 text-xs font-normal text-zinc-100 opacity-0 shadow-lg ring-1 ring-zinc-700 group-hover:opacity-100 group-focus-visible:opacity-100"
      >
        {DESKTOP_ZH.planTooltip}
      </span>
    </button>
  );
}
