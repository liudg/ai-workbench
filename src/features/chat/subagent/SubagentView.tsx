import { useMemo } from "react";
import { ArrowUpLeft, Square } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SessionAgentIcon } from "@/shared/agent/SessionAgentIcon";
import type { Session } from "@/types";
import { AnswerMarkdownHost } from "../answer/AnswerMarkdownHost";
import {
  SUBAGENT_STATUS_LABELS,
  subagentElapsed,
  subagentSessionStatus,
  subagentSteps,
  subagentTimeline,
  subagentTitle,
  type SubagentEvent,
} from "../events/subagent-display";
import { agentTurnName, useAgentIdentity } from "../events/use-agent-identity";
import { ChatHostProvider, useChatHost, type ChatHost } from "../host";
import { ChatView } from "../timeline/ChatView";
import { formatElapsed } from "../timeline/timeline";
import { useElapsedSince } from "../timeline/useElapsedSince";
import type { SessionEvent } from "@/types";

/**
 * 单独打开的一个 Agent 自带子 Agent：和会话一样的时间线，作曲栏换成一条状态栏。
 * 原生子 Agent 不能插话，所以只能看。照 t3code `apps/web/src/components/chat/ProviderSubagentBar.tsx`。
 */
export function SubagentView({
  card,
  events,
  parent,
  onBack,
  onStop,
}: {
  card: SubagentEvent;
  /** 父会话的事件，从里面取这个子 Agent 的步骤。 */
  events: readonly SessionEvent[];
  parent: Session;
  onBack: () => void;
  /** 能单独停它时给。 */
  onStop?: () => void;
}) {
  const steps = useMemo(() => subagentSteps(events).get(card.subagent_id) ?? [], [events, card.subagent_id]);
  const timeline = useMemo(() => subagentTimeline(card, steps), [card, steps]);
  const session = useMemo<Session>(
    () => ({
      ...parent,
      id: `${parent.id}:${card.subagent_id}`,
      title: subagentTitle(card),
      status: subagentSessionStatus(card),
    }),
    [parent, card],
  );
  // 这里的会话 id 是拼出来的。附加到作曲栏的内容落到父会话，回去就能看到。
  const outer = useChatHost();
  const host = useMemo<ChatHost>(() => {
    const add = outer.addTextSnippet;
    return { ...outer, addTextSnippet: add ? (_, draft) => add(parent.id, draft) : undefined };
  }, [outer, parent.id]);
  return (
    <div data-subagent-view={card.subagent_id} className="flex h-full min-h-0 flex-col">
      <ChatHostProvider host={host}>
        <AnswerMarkdownHost>
          <ChatView
            session={session}
            events={timeline}
            renderComposer={() => <SubagentBar card={card} agent={parent.agent} onBack={onBack} onStop={onStop} />}
          />
        </AnswerMarkdownHost>
      </ChatHostProvider>
    </div>
  );
}

/** 「Agent 图标 · 模型 · 强度 · 状态计时 · 独立运行 · 回到父会话」。 */
function SubagentBar({
  card,
  agent,
  onBack,
  onStop,
}: {
  card: SubagentEvent;
  agent: Session["agent"];
  onBack: () => void;
  onStop?: () => void;
}) {
  const identity = useAgentIdentity(agent);
  const running = card.status === "running";
  const ticking = useElapsedSince(running ? (card.started_at ?? null) : null);
  const elapsed = running ? ticking : subagentElapsed(card, Date.now());
  const status = elapsed != null ? `${SUBAGENT_STATUS_LABELS[card.status]} · ${formatElapsed(elapsed)}` : SUBAGENT_STATUS_LABELS[card.status];
  const model = card.model?.trim() || agentTurnName(agent, identity);
  return (
    <div className="px-4 pb-4">
      <div
        data-subagent-bar
        className="flex min-h-12 min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl border border-[#2a2a2a] bg-[#171717] py-2 pl-4 pr-2 text-sm"
      >
        <span className="flex min-w-0 items-center gap-2">
          <SessionAgentIcon identity={identity} className="h-4 w-4" />
          <span className="min-w-0 truncate font-medium text-[#e4e4e4]">{model}</span>
          {card.effort ? <span className="shrink-0 text-[#8a8a8a]">{card.effort}</span> : null}
        </span>
        <span className={running ? "shrink-0 tabular-nums text-[#8fb4ff]" : card.status === "failed" ? "shrink-0 text-red-400" : "shrink-0 tabular-nums text-[#8a8a8a]"}>
          {status}
        </span>
        <span className="min-w-0 flex-1" />
        <span className="shrink-0 text-[#7a7a7a]">独立运行</span>
        {running && onStop ? (
          <Button size="sm" variant="ghost" onClick={onStop}>
            <Square className="h-3.5 w-3.5" />
            停止
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={onBack}>
          <ArrowUpLeft className="h-4 w-4" />
          回到父会话
        </Button>
      </div>
    </div>
  );
}
