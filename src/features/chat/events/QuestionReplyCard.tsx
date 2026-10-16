import { useState } from "react";
import { ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";

import {
  questionReplyStartsCollapsed,
  questionReplyTitle,
  type QuestionReplyRow,
} from "./question-reply";

/** 答完后的题/答行。三题及以上先收成标题，点开再看每题。 */
export function QuestionReplyCard({ rows }: { rows: readonly QuestionReplyRow[] }) {
  const collapsible = questionReplyStartsCollapsed(rows.length);
  const [open, setOpen] = useState(!collapsible);
  const collapsed = collapsible && !open;
  const title = questionReplyTitle(rows.length);
  return (
    <div
      data-question-answers
      data-question-count={rows.length}
      data-collapsed={collapsed ? "true" : "false"}
      className="w-fit min-w-[12rem] max-w-[min(28rem,100%)] overflow-hidden rounded-lg border border-[#2a2a2a] bg-[#1a1a1a] text-left"
    >
      {collapsible ? (
        <button
          type="button"
          data-question-answers-toggle
          aria-expanded={!collapsed}
          aria-label={collapsed ? `展开${title}` : `收起${title}`}
          onClick={() => setOpen((value) => !value)}
          className="flex w-full min-w-0 cursor-pointer items-center gap-2 px-3 py-2 text-left text-[13px] text-[#d4d4d4] hover:bg-[#222]"
        >
          <span className="min-w-0 flex-1">{title}</span>
          <ChevronRight
            className={cn("h-4 w-4 shrink-0 text-[#777] transition-transform", open && "rotate-90")}
          />
        </button>
      ) : (
        <div className="px-3 pt-2 text-[13px] text-[#d4d4d4]">{title}</div>
      )}
      {collapsed ? null : (
        <div className={cn("flex flex-col gap-2 px-3 pb-2.5", collapsible ? "pt-1" : "pt-2")}>
          {rows.map((row, index) => (
            <div key={`${index}:${row.question}`} data-question-row className="min-w-0">
              <p className="break-words text-xs leading-5 text-zinc-500">{row.question}</p>
              <p className="break-words whitespace-pre-wrap text-sm leading-5 text-[#f3f3f3]">{row.answer}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
