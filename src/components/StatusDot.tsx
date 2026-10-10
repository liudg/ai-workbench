import { cn } from "@/lib/utils";
import type { SessionStatus } from "@/types";

const STYLES: Record<SessionStatus | "none", string> = {
  running: "bg-sky-400 animate-pulse",
  "needs-input": "bg-amber-400 animate-pulse",
  completed: "bg-emerald-400",
  failed: "bg-red-400",
  stopped: "bg-zinc-500",
  none: "bg-transparent border border-zinc-600",
};

export function StatusDot({
  status,
  className,
}: {
  status: SessionStatus | null;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-block h-2 w-2 shrink-0 rounded-full",
        STYLES[status ?? "none"],
        className,
      )}
    />
  );
}
