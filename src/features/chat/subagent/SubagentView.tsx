import { useMemo } from "react";

import type { Session } from "@/types";
import { AnswerMarkdownHost } from "../answer/AnswerMarkdownHost";
import {
  subagentSessionStatus,
  subagentSteps,
  subagentTimeline,
  subagentTitle,
  type SubagentEvent,
} from "../events/subagent-display";
import { ChatHostProvider, useChatHost, type ChatHost } from "../host";
import { ChatView } from "../timeline/ChatView";
import type { SessionEvent } from "@/types";

/**
 * 一个 Agent 自带子 Agent 的过程：和会话一样的时间线。原生子 Agent 不能插话，所以没有作曲栏。
 * 照 t3code `packages/provider-core/src/server/subagentProjection.ts` 把子 Agent 投影成子线程。
 */
export function SubagentView({
  card,
  events,
  parent,
}: {
  card: SubagentEvent;
  /** 父会话的事件，从里面取这个子 Agent 的步骤。 */
  events: readonly SessionEvent[];
  parent: Session;
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
  // 这里的会话 id 是拼出来的。附加到作曲栏的内容落到父会话。
  const outer = useChatHost();
  const host = useMemo<ChatHost>(() => {
    const add = outer.addTextSnippet;
    return { ...outer, addTextSnippet: add ? (_, draft) => add(parent.id, draft) : undefined };
  }, [outer, parent.id]);
  return (
    <div data-subagent-view={card.subagent_id} className="flex h-full min-h-0 flex-col">
      <ChatHostProvider host={host}>
        <AnswerMarkdownHost>
          <ChatView session={session} events={timeline} renderComposer={() => null} />
        </AnswerMarkdownHost>
      </ChatHostProvider>
    </div>
  );
}
