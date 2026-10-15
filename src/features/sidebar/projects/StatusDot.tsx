import { cn } from "@/lib/utils";
import type { SessionStatus } from "@/types";

const STYLES: Record<SessionStatus | "none", string> = {
  running: "bg-[#4f8dff] animate-pulse",
  "needs-input": "bg-amber-400 animate-pulse",
  completed: "bg-[#22c55e]",
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
        "inline-block h-1.5 w-1.5 shrink-0 rounded-full",
        STYLES[status ?? "none"],
        className,
      )}
    />
  );
}
