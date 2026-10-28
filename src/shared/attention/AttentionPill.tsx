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
      className={cn("inline-flex shrink-0 items-center gap-1 text-[10px] leading-none", pill.textClass, className)}
    >
      <span
        className={cn("h-1.5 w-1.5 shrink-0 rounded-full", pill.dotClass, pill.pulse && "motion-safe:animate-pulse")}
      />
      {!compact && <span>{pill.label}</span>}
    </span>
  );
}
