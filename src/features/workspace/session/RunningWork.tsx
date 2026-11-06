import { useState } from "react";
import { ChevronDown } from "lucide-react";

import { formatElapsed } from "@/features/chat/timeline/timeline";
import { useElapsedSince } from "@/features/chat/timeline/useElapsedSince";
import { cn } from "@/lib/utils";
import { SessionAgentIcon } from "@/shared/agent/SessionAgentIcon";
import { agentIdentity } from "@/shared/agent/identity";
import type { AgentKind, AgentProfile } from "@/types";
import type { RunningItem } from "./use-running-work";

/**
 * 作曲栏上方的一条：还在跑的子任务和子 Agent。组头汇总个数，展开后每行能打开、能停，也能全部停。
 * 照 orca `src/renderer/src/components/native-chat/NativeChatBackgroundTasksStatus.tsx`。
 */
export function RunningWork({
  items,
  profiles,
  onStopAll,
}: {
  items: readonly RunningItem[];
  profiles: Partial<Record<AgentKind, AgentProfile>>;
  onStopAll: () => void;
}) {
  const [expanded, setExpanded] = useState(true);
  if (items.length === 0) return null;
  const subtasks = items.filter((item) => item.kind === "subtask").length;
  const subagents = items.length - subtasks;
  const header = [subtasks > 0 ? `${subtasks} 个子任务` : "", subagents > 0 ? `${subagents} 个子 Agent` : ""]
    .filter(Boolean)
    .join(" · ");
  const canStopAll = items.some((item) => item.stop) || subagents > 0;
  return (
    <div data-running-work={items.length} className="px-4 pt-2">
      <div className="overflow-hidden rounded-lg border border-[#2a2a2a] bg-[#161616] text-[12px] text-[#9a9a9a]">
        <div className="flex h-8 items-center gap-1 px-1.5">
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
            className="flex h-6 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-left hover:bg-white/[0.04]"
          >
            <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[#8fb4ff] motion-reduce:animate-none" />
            <span className="min-w-0 truncate font-medium text-[#d4d4d4]">{header}</span>
            <span className="text-[#7a7a7a]">在跑</span>
            <ChevronDown className={cn("ml-auto h-3.5 w-3.5 shrink-0 transition-transform", !expanded && "-rotate-90")} />
          </button>
          {canStopAll ? (
            <button
              type="button"
              onClick={onStopAll}
              className="h-6 shrink-0 rounded-md px-2 text-[#bdbdbd] hover:bg-white/[0.06] hover:text-white"
            >
              全部停止
            </button>
          ) : null}
        </div>
        {expanded ? (
          <ul className="m-0 list-none space-y-0.5 border-t border-[#232323] px-1.5 py-1.5">
            {items.map((item) => (
              <Row key={`${item.kind}:${item.id}`} item={item} profile={profiles[item.agent]} />
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

function Row({ item, profile }: { item: RunningItem; profile: AgentProfile | undefined }) {
  const elapsed = useElapsedSince(item.since);
  return (
    <li data-running-item={item.kind} className="flex h-7 min-w-0 items-center gap-1">
      <button
        type="button"
        onClick={item.open}
        className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-left hover:bg-white/[0.04]"
      >
        <SessionAgentIcon identity={agentIdentity(item.agent, profile)} className="h-3.5 w-3.5" />
        <span className="shrink-0 text-[#7a7a7a]">{item.kind === "subtask" ? "子任务" : "子 Agent"}</span>
        <span className="min-w-0 shrink truncate font-medium text-[#d4d4d4]">{item.title}</span>
        {item.detail ? <span className="min-w-0 flex-1 truncate text-[#8a8a8a]">{item.detail}</span> : <span className="flex-1" />}
        <span className={cn("shrink-0", item.statusClass)}>{item.status}</span>
        {elapsed != null ? <span className="shrink-0 tabular-nums text-[#7a7a7a]">{formatElapsed(elapsed)}</span> : null}
      </button>
      {item.stop ? (
        <button
          type="button"
          aria-label={`停止 ${item.title}`}
          onClick={item.stop}
          className="h-6 shrink-0 rounded-md px-2 text-[#bdbdbd] hover:bg-white/[0.06] hover:text-white"
        >
          停止
        </button>
      ) : null}
    </li>
  );
}
