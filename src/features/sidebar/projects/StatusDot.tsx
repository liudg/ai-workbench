import { cn } from "@/lib/utils";
import type { SessionStatus } from "@/types";

const STYLES: Record<SessionStatus | "none", string> = {
  running: "bg-[var(--wb-accent)] animate-pulse",
  "needs-input": "bg-[var(--wb-warn-strong)] animate-pulse",
  completed: "bg-[var(--wb-success-strong)]",
  failed: "bg-[var(--wb-danger-strong)]",
  stopped: "bg-[var(--wb-faint)]",
  none: "bg-transparent border border-[var(--wb-border-strong)]",
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
