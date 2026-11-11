import { useEffect, useState } from "react";
import { Bot } from "lucide-react";

import { cn } from "@/lib/utils";
import type { AgentIdentity } from "./identity";

export function SessionAgentIcon({
  identity,
  className,
}: {
  identity: AgentIdentity | null;
  className?: string;
}) {
  const src = identity?.icon ?? null;
  const name = identity?.name ?? "";
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
  }, [src]);

  const label = name || undefined;
  if (src && !failed) {
    return (
      <img
        src={src}
        alt={name}
        title={label}
        data-agent-icon={src}
        data-agent-icon-mono={identity?.monochrome ? "true" : undefined}
        draggable={false}
        className={cn("h-[18px] w-[18px] shrink-0", className)}
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span
      title={label}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-agent-icon="generic"
      className={cn("flex h-[18px] w-[18px] shrink-0 items-center justify-center text-[var(--wb-muted)]", className)}
    >
      <Bot className="h-3.5 w-3.5" aria-hidden />
    </span>
  );
}
