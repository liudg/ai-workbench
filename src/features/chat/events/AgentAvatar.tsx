import { cn } from "@/lib/utils";
import { SessionAgentIcon } from "@/shared/agent/SessionAgentIcon";
import type { AgentIdentity } from "@/shared/agent/identity";

/** 圆底的 Agent 图标，右下角一个状态点。照 t3code `V2LifecycleRow.tsx` 的 `SubagentAvatar`。 */
export function AgentAvatar({
  identity,
  dotClass,
  pulse = false,
  className,
}: {
  identity: AgentIdentity | null;
  dotClass?: string;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-wb-border-strong bg-wb-elev ring-2 ring-wb-surface",
        className,
      )}
    >
      <SessionAgentIcon identity={identity} className="h-3.5 w-3.5" />
      {dotClass ? (
        <span
          className={cn(
            "absolute -bottom-px -right-px h-2 w-2 rounded-full ring-2 ring-wb-surface",
            dotClass,
            pulse && "animate-pulse motion-reduce:animate-none",
          )}
        />
      ) : null}
    </span>
  );
}
