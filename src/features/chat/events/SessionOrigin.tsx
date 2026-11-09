import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { relativeTimeAgo } from "@/shared/format/relative-time";
import type { AgentKind, SessionEvent } from "@/types";
import { MessageContent } from "../answer/MessageContent";
import { useChatHost } from "../host";
import { agentTurnName, useAgentIdentity } from "./use-agent-identity";

/** 第一条消息就是开会话的说明：画成信息流头部，分任务和上下文折叠。照 Claude Code 桌面版嵌套会话的头部。 */
export function SessionOrigin({
  event,
  title,
  time,
}: {
  event: Extract<SessionEvent, { kind: "user-message" }>;
  title: string;
  time: string;
}) {
  const [open, setOpen] = useState(true);
  const subtasks = useChatHost().subtasks;
  const originId = event.sender?.task_ids[0];
  const originTitle = originId ? subtasks?.title(originId) : undefined;
  const originAgent = originId ? subtasks?.agent(originId) : undefined;
  const background = event.sender?.background;
  const notes = event.sender?.notes;
  return (
    <div className="event-in min-w-0 px-6 py-2" data-session-origin="">
      <div className="flex min-w-0 items-center gap-1 text-xs text-zinc-500">
        <span className="flex min-w-0 items-center">
          {originAgent ? <StartedBy agent={originAgent} /> : null}
          <span className="shrink-0">来自</span>
          {originId && originTitle ? (
            <button
              type="button"
              className="ml-1 min-w-0 truncate text-zinc-300 underline-offset-2 hover:text-zinc-100 hover:underline"
              onClick={() => subtasks?.open(originId)}
            >
              {originTitle}
            </button>
          ) : (
            <span className="ml-1 shrink-0">其他会话</span>
          )}
        </span>
        <button
          type="button"
          className="flex shrink-0 items-center gap-0.5 rounded px-0.5 hover:text-zinc-300"
          aria-label={open ? "收起" : "展开"}
          aria-expanded={open}
          title={time}
          onClick={() => setOpen((value) => !value)}
        >
          {relativeTimeAgo(event.ts, Date.now())}
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </button>
      </div>
      {open ? (
        <div className="mt-1.5 min-w-0 divide-y divide-white/10 rounded-xl border border-white/10">
          <OriginRow label="任务" title={title} name="task">
            <ClampedText text={event.text} />
          </OriginRow>
          {background || notes ? (
            <OriginRow label="上下文" name="context">
              <div className="text-sm text-zinc-300">
                {background ? <MessageContent text={background} /> : null}
                {notes ? <p className="mt-2 break-all text-xs text-zinc-500">共享笔记目录：{notes}</p> : null}
              </div>
            </OriginRow>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function StartedBy({ agent }: { agent: AgentKind }) {
  const identity = useAgentIdentity(agent);
  return <span className="mr-1 shrink-0">由 {agentTurnName(agent, identity)} 启动，</span>;
}

function OriginRow({
  label,
  title,
  name,
  children,
}: {
  label: string;
  title?: string;
  name: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div className="min-w-0 px-3.5 py-2.5" data-origin-row={name}>
      <button
        type="button"
        className="group flex max-w-full min-w-0 items-center gap-2 text-left text-sm"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="shrink-0 text-zinc-500">{label}</span>
        {title ? <span className="min-w-0 truncate font-medium text-zinc-200">{title}</span> : null}
        <Chevron className="h-3.5 w-3.5 shrink-0 text-zinc-500 group-hover:text-zinc-300" />
      </button>
      {open ? <div className="mt-2 min-w-0">{children}</div> : null}
    </div>
  );
}

/** 说明太长时先露出三行。 */
function ClampedText({ text }: { text: string }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const frame = frameRef.current;
    const content = contentRef.current;
    if (full || !frame || !content) return;
    const measure = () => setOverflows(content.offsetHeight > frame.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    observer.observe(content);
    return () => observer.disconnect();
  }, [full, text]);
  return (
    <div className="min-w-0">
      <div ref={frameRef} className={full ? "min-w-0" : "max-h-[4.5rem] min-w-0 overflow-hidden"}>
        <div ref={contentRef} className="text-sm text-zinc-300">
          <MessageContent text={text} />
        </div>
      </div>
      {full || overflows ? (
        <button
          type="button"
          className="mt-1.5 text-xs text-zinc-400 hover:text-zinc-200"
          onClick={() => setFull((value) => !value)}
        >
          {full ? "收起" : "显示更多"}
        </button>
      ) : null}
    </div>
  );
}
