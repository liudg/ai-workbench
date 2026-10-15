import type { Session, SessionEvent } from "@/types";
import { ActivityStream } from "./ActivityStream";
import { pickAnswer } from "./timeline";

/**
 * 进行中的一轮里已经写出来的过程。相邻工具收成一行，思考默认收起且最多一条。
 * 「正在处理」折叠行由时间线放在变更卡片之后，留在对话末尾。
 */
export function LiveTurn({
  events,
  session,
  resolvedAnswers,
  expanded,
  onInteract,
}: {
  events: SessionEvent[];
  session: Session;
  resolvedAnswers: ReadonlyMap<string, string>;
  expanded: boolean;
  onInteract?: () => void;
}) {
  const answer = pickAnswer(events, false);

  if (!expanded) return <div className="min-w-0" data-live-turn />;

  return (
    <div className="min-w-0" data-live-turn>
      <ActivityStream
        events={events}
        session={session}
        resolvedAnswers={resolvedAnswers}
        showAgentLabel={(event) => answer != null && event.id === answer.id}
        onInteract={onInteract}
      />
    </div>
  );
}
