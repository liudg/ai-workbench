import { cn } from "@/lib/utils";
import type { AttentionPillView } from "./attention";

/** 状态药丸：点加字。`compact` 只画点，字放进悬停提示。照 t3code `ThreadStatusIndicators.tsx` 的 `ThreadStatusLabel`。 */
export function AttentionPill({
  pill,
  compact = false,
  className,
}: {
  pill: AttentionPillView | null;
  compact?: boolean;
  className?: string;
}) {
  if (!pill) return null;
  return (
    <span
      role="img"
      aria-label={pill.label}
      title={pill.label}
      data-attention={pill.tone}
      className={cn(
        "inline-flex shrink-0 items-center",
        compact
          ? pill.textClass
          : cn("gap-1 rounded-full px-1.5 py-0.5 text-xs font-medium leading-4", pill.bgClass, pill.textClass),
        className,
      )}
    >
      <span
        className={cn("h-1.5 w-1.5 shrink-0 rounded-full", pill.dotClass, pill.pulse && "motion-safe:animate-pulse")}
      />
      {!compact && <span>{pill.label}</span>}
    </span>
  );
}
