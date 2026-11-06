import { ChevronRight, Columns2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { agentIdentity } from "@/shared/agent/identity";
import type { SubtaskSpec } from "@/types";
import { useChatHost, type ChatHost, type SubtaskHost } from "../host";
import { formatElapsed } from "../timeline/timeline";
import { useElapsedSince } from "../timeline/useElapsedSince";
import { AgentAvatar } from "./AgentAvatar";
import { HoverCard } from "./HoverCard";
import { subtaskDetail, subtaskStatus } from "./subtask-row";
import { agentTurnName } from "./use-agent-identity";

/**
 * 父时间线里开出的子任务，一个一行：Agent 图标、标题、最新一句、状态、计时；点整行打开子任务。
 * 照 t3code `apps/web/src/components/chat/V2LifecycleRow.tsx` 的 `SubagentTimelineLink`。
 */
export function SubtaskRows({ taskIds, specs }: { taskIds: readonly string[]; specs: readonly SubtaskSpec[] }) {
  const { subtasks, profiles } = useChatHost();
  if (!subtasks || taskIds.length === 0) return null;
  return (
    <div className="event-in min-w-0 px-6 py-1" data-subtask-rows={taskIds.length}>
      <div className="min-w-0 pl-6">
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
          {taskIds.map((taskId, index) => (
            <SubtaskRow key={taskId} taskId={taskId} spec={specs[index]} host={subtasks} profiles={profiles} />
          ))}
        </ul>
      </div>
    </div>
  );
}

function SubtaskRow({
  taskId,
  spec,
  host,
  profiles,
}: {
  taskId: string;
  spec: SubtaskSpec | undefined;
  host: SubtaskHost;
  profiles: ChatHost["profiles"];
}) {
  const view = host.useSubtask(taskId);
  const agent = view?.agent ?? spec?.agent;
  const identity = agent ? agentIdentity(agent, profiles[agent]) : null;
  const status = view ? subtaskStatus(view.attention) : null;
  const ticking = useElapsedSince(status?.running ? (view?.since ?? null) : null);
  const title = view?.title.trim() || spec?.title || "子任务";
  const detail = view ? subtaskDetail(view.attention) : "";
  const gone = !view;
  return (
    <li data-subtask-row={taskId} data-subtask-state={view?.attention.state ?? "gone"} className="group/subtask relative min-w-0">
      <HoverCard
        content={
          <SubtaskCard
            title={title}
            agentName={agent ? agentTurnName(agent, identity) : ""}
            status={status?.label ?? "已删除"}
            prompt={spec?.prompt ?? ""}
            detail={detail}
          />
        }
      >
        <button
          type="button"
          disabled={gone}
          aria-label={`打开 ${title}`}
          onClick={() => host.open(taskId)}
          className="flex w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors enabled:hover:bg-white/[0.04] disabled:opacity-60"
        >
          <AgentAvatar identity={identity} dotClass={status?.dotClass} pulse={status?.running} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium text-[#d4d4d4]">{title}</span>
            <span
              className={cn(
                "block truncate text-[12px] leading-5",
                view?.attention.state === "failed" ? "text-red-400/90" : "text-[#8a8a8a]",
              )}
              data-subtask-detail
            >
              {detail || status?.label || "已删除"}
            </span>
          </span>
          {status && detail ? <span className={cn("shrink-0 text-[12px]", status.textClass)}>{status.label}</span> : null}
          {ticking != null ? (
            <span className="shrink-0 text-[12px] tabular-nums text-[#8a8a8a]">{formatElapsed(ticking)}</span>
          ) : null}
          {/* 给右边的「并排看」按钮留位置。 */}
          <span className="w-6 shrink-0" aria-hidden />
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[#666] group-hover/subtask:text-[#bbb]" />
        </button>
      </HoverCard>
      {gone ? null : (
        <button
          type="button"
          title="在旁边打开"
          aria-label={`在旁边打开 ${title}`}
          onClick={() => host.openBeside(taskId)}
          className="absolute right-7 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-[#777] opacity-0 hover:bg-white/[0.08] hover:text-[#ddd] focus-visible:opacity-100 group-hover/subtask:opacity-100"
        >
          <Columns2 className="h-3.5 w-3.5" />
        </button>
      )}
    </li>
  );
}

function SubtaskCard({
  title,
  agentName,
  status,
  prompt,
  detail,
}: {
  title: string;
  agentName: string;
  status: string;
  prompt: string;
  detail: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="font-medium text-[#e4e4e4]">{title}</div>
      <div className="text-[#8a8a8a]">{[agentName, status].filter(Boolean).join(" · ")}</div>
      {prompt ? <p className="m-0 line-clamp-4 whitespace-pre-wrap break-words text-[#9a9a9a]">{prompt}</p> : null}
      {detail ? <p className="m-0 line-clamp-3 break-words text-[#bdbdbd]">{detail}</p> : null}
    </div>
  );
}
