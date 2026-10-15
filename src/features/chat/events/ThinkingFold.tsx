import { ChevronDown, Sparkles } from "lucide-react";

import { cn } from "@/lib/utils";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { CopyButton } from "./chrome";

/** 一条思考。默认收起，和活动摘要卡对齐。 */
export function ThinkingFold({
  text,
  open,
  onToggle,
}: {
  text: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="event-in min-w-0 px-6 py-1">
      <div className="min-w-0 pl-6">
        <button
          type="button"
          data-thinking-toggle
          aria-expanded={open}
          onClick={onToggle}
          className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-[#2a2a2a] bg-[#1a1a1a] px-2.5 py-1 text-left text-[12.5px] text-[#cfcfcf] hover:bg-[#222]"
        >
          <Sparkles className="h-3.5 w-3.5 shrink-0 text-[#9a9a9a]" />
          <span>{DESKTOP_ZH.activityThinking}</span>
          <ChevronDown
            className={cn("h-3.5 w-3.5 shrink-0 text-[#777] transition-transform", open && "rotate-180")}
          />
        </button>
        {open ? (
          <div className="mt-2 min-w-0">
            <p className="break-words whitespace-pre-wrap text-sm leading-6 text-zinc-400">{text}</p>
            <div className="mt-1 flex justify-end">
              <CopyButton text={text} />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
