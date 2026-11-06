import { ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";
import { agentIdentity } from "@/shared/agent/identity";
import type { SubtaskSpec } from "@/types";
import { useChatHost, type ChatHost, type SubtaskHost } from "../host";
import { AgentAvatar } from "./AgentAvatar";
import { HoverCard } from "./HoverCard";
import { subtaskDetail, subtaskStatus } from "./subtask-row";
import { agentTurnName } from "./use-agent-identity";

/** 时间线里开出的嵌套会话，一个一张卡：Agent 图标、标题、状态；点开进子智能体面板。照 Claude 桌面端的会话卡片。 */
export function SubtaskRows({ taskIds, specs }: { taskIds: readonly string[]; specs: readonly SubtaskSpec[] }) {
  const { subtasks, profiles } = useChatHost();
  if (!subtasks || taskIds.length === 0) return null;
  return (
    <div className="event-in min-w-0 px-6 py-1" data-subtask-rows={taskIds.length}>
      <div className="min-w-0 pl-6">
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
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
  const title = view?.title.trim() || spec?.title || "子任务";
  const detail = view ? subtaskDetail(view.attention) : "";
  return (
    <li data-subtask-row={taskId} data-subtask-state={view?.attention.state ?? "gone"} className="min-w-0">
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
          disabled={!view}
          aria-label={`打开 ${title}`}
          onClick={() => host.open(taskId)}
          className="flex w-full min-w-0 items-center gap-2.5 rounded-lg border border-[#2a2a2a] bg-[#1a1a1a] px-3 py-2 text-left transition-colors enabled:hover:bg-[#222] disabled:opacity-60"
        >
          <AgentAvatar identity={identity} dotClass={status?.dotClass} pulse={status?.running} />
          <span className="min-w-0 flex-1 truncate text-[13px] text-[#d4d4d4]">{title}</span>
          <span className={cn("shrink-0 text-[12px]", status?.textClass ?? "text-[#8a8a8a]")}>
            {status?.label ?? "已删除"}
          </span>
          <ChevronRight className="h-4 w-4 shrink-0 text-[#777]" />
        </button>
      </HoverCard>
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
