import { MessageSquare, RotateCcw } from "lucide-react";

import { cn } from "@/lib/utils";
import { profileForSessionAgent } from "@/shared/agent/identity";

import { MessageContent } from "../answer/MessageContent";
import { useOptionalChatHost } from "../host";
import { useMessageMenu } from "../message-menu";
import { canRewindUserEvent } from "../rewind/restore-draft";
import { annotationCountLabel, annotationCountOf } from "./annotation-count";
import { CopyButton, HoverActions } from "./chrome";
import { EventImages } from "./EventImages";
import { QuestionReplyCard } from "./QuestionReplyCard";
import { SessionOrigin } from "./SessionOrigin";
import { SubtaskReport } from "./SubtaskReport";
import { parseQuestionReply } from "./question-reply";
import type { EventViewProps } from "./types";
import { useEventAgent, useEventInstanceId } from "./use-agent-identity";
import { userBubbleModel } from "./user-image-layout";

export function UserBubble({ event, session, time }: EventViewProps) {
  const host = useOptionalChatHost();
  const agent = useEventAgent(event, session);
  const instanceId = useEventInstanceId(event);
  const profile = profileForSessionAgent(agent, host?.profiles, instanceId);
  const rewindAllowed = canRewindUserEvent({
    hasHostRewind: Boolean(host?.requestRewind),
    event,
    supportsConversationRewind: profile?.capabilities.supports_conversation_rewind,
  });
  const sessionBusy =
    session.status === "running" ||
    session.status === "starting" ||
    session.status === "needs-input";
  const triggerRewind = () => {
    if (!sessionBusy) host?.requestRewind?.(event.session_id, event.id);
  };
  const onContextMenu = useMessageMenu(
    event.kind === "user-message" && !event.sender ? event.text : "",
    rewindAllowed ? { disabled: sessionBusy, onSelect: triggerRewind } : null,
  );
  if (event.kind !== "user-message") return null;
  if (event.sender && (event.seq === 1 || event.sender.fork)) return <SessionOrigin event={event} title={session.title} time={time} />;
  if (event.sender) return <SubtaskReport text={event.text} taskIds={event.sender.task_ids} time={time} />;
  const text = event.text;
  const images = event.images ?? [];
  const replies = parseQuestionReply(text);
  const badge = annotationCountOf(event.annotations);
  const model = userBubbleModel(text, images.length);
  return (
    <div className="event-in group min-w-0 px-6 py-2">
      <div className="flex min-w-0 justify-end">
        <div
          className={cn(
            "flex min-w-0 max-w-[85%] flex-col items-end gap-1.5",
            model.images && "w-full",
          )}
        >
          {model.images ? (
            <div
              data-user-image-layer
              data-image-count={images.length}
              data-image-columns={model.images.columns}
              className={model.images.frameClassName}
              onContextMenu={!model.showTextBubble ? onContextMenu : undefined}
            >
              <EventImages paths={images} className={model.images.thumbClassName} />
            </div>
          ) : null}
          {replies ? (
            <QuestionReplyCard rows={replies} />
          ) : model.showTextBubble ? (
            <div data-user-text data-message-body className={model.textBubbleClass} onContextMenu={onContextMenu}>
              {text ? <MessageContent text={text} /> : null}
            </div>
          ) : null}
          {badge ? (
            <span
              data-annotation-count={badge.count}
              className="inline-flex items-center gap-1 rounded-full border border-wb-border bg-wb-elev px-2 py-0.5 text-xs text-wb-fg-2"
            >
              <MessageSquare className="h-3 w-3" />
              {annotationCountLabel(badge.count)}
            </span>
          ) : null}
          <HoverActions time={time}>
            {rewindAllowed ? (
              <button
                type="button"
                data-rewind-turn=""
                disabled={sessionBusy}
                title={sessionBusy ? "请先等待或停止当前回合" : "回退到此处"}
                aria-label="回退到此处"
                className="inline-flex h-6 w-6 items-center justify-center rounded-md text-wb-fg-3 transition-colors hover:bg-wb-hover hover:text-wb-fg disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent"
                onClick={triggerRewind}
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
            ) : null}
            {text ? <CopyButton text={text} /> : null}
          </HoverActions>
        </div>
      </div>
    </div>
  );
}
