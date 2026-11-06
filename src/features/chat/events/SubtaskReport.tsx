import { Fragment, useState } from "react";
import { ChevronDown, ChevronRight, CornerDownRight } from "lucide-react";

import { MessageContent } from "../answer/MessageContent";
import { useChatHost } from "../host";
import { HoverActions, CopyButton } from "./chrome";

/** 子任务送回来的结果折成一行，标出来自哪些子任务，点开看全文，点标题跳过去。照 t3code `TimelineUserMessageRow.tsx`。 */
export function SubtaskReport({ text, taskIds, time, defaultOpen = false }: {
  text: string; taskIds: string[]; time: string; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const subtasks = useChatHost().subtasks;
  return (
    <div className="event-in group min-w-0 px-6 py-1.5" data-subtask-report="">
      <div className="flex min-w-0 items-center gap-1.5 text-xs text-zinc-500">
        <CornerDownRight className="h-3 w-3 shrink-0" />
        <span className="shrink-0">来自</span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-1">
          {taskIds.length === 0 ? <span>工作台</span> : null}
          {taskIds.map((id, index) => (
            <Fragment key={id}>
              {index > 0 ? <span>、</span> : null}
              <button
                type="button"
                className="max-w-[16rem] truncate font-medium text-zinc-400 hover:text-zinc-200 hover:underline"
                onClick={() => subtasks?.open(id)}
              >
                {subtasks?.title(id) ?? "任务"}
              </button>
            </Fragment>
          ))}
        </span>
        <button
          type="button"
          className="flex shrink-0 items-center rounded p-0.5 hover:bg-zinc-800 hover:text-zinc-200"
          aria-label={open ? "收起" : "展开"}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </button>
        <HoverActions time={time}>
          <CopyButton text={text} />
        </HoverActions>
      </div>
      {open ? (
        <div className="mt-1.5 min-w-0 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 text-sm text-zinc-300">
          <MessageContent text={text} />
        </div>
      ) : null}
    </div>
  );
}
