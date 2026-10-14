import { useEffect, useState } from "react";
import { Bot } from "lucide-react";

import type { AgentIdentity } from "./agent-identity";

export function SessionAgentIcon({ identity }: { identity: AgentIdentity | null }) {
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
        draggable={false}
        className="h-[18px] w-[18px] shrink-0"
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
      className="flex h-[18px] w-[18px] shrink-0 items-center justify-center text-zinc-300"
    >
      <Bot className="h-3.5 w-3.5" aria-hidden />
    </span>
  );
}
