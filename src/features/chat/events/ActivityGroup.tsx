import { ChevronRight, LayoutGrid, Search } from "lucide-react";

import { cn } from "@/lib/utils";
import { relativizeDisplayText } from "@/shared/path";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import type { Session } from "@/types";
import type { ActivityPiece, ToolCallEvent } from "./activity-fold";
import { CopyButton } from "./chrome";
import { EventImages } from "./EventImages";
import { useSessionProjectPath } from "./use-session-project-path";

type ToolPiece = Extract<ActivityPiece, { type: "tools" }>;

/**
 * 一组相邻工具的摘要行。默认一行。点开后按时间顺序看到每一步的命令和输出。
 */
export function ActivityGroup({
  piece,
  session,
  open,
  onToggle,
}: {
  piece: ToolPiece;
  session: Session;
  open: boolean;
  onToggle: () => void;
}) {
  const projectPath = useSessionProjectPath(session);

  return (
    <div className="event-in min-w-0 px-6 py-1" data-activity-group data-activity-summary={piece.summary}>
      <div className="min-w-0 pl-6">
        <div className="overflow-hidden rounded-lg border border-[#2a2a2a] bg-[#1a1a1a]">
          <button
            type="button"
            data-activity-toggle
            data-expanded={open ? "true" : "false"}
            aria-expanded={open}
            title={piece.summary}
            onClick={onToggle}
            className="flex w-full min-w-0 items-center gap-2.5 px-3 py-2 text-left text-[13px] text-[#d4d4d4] hover:bg-[#222]"
          >
            <LayoutGrid className="h-3.5 w-3.5 shrink-0 text-[#8a8a8a]" />
            <span className="min-w-0 flex-1 truncate">{piece.summary}</span>
            {piece.webSearch ? (
              <span className="inline-flex shrink-0 items-center gap-1 text-[12px] text-[#9a9a9a]">
                <Search className="h-3.5 w-3.5" />
                {DESKTOP_ZH.activitySearchedWeb}
              </span>
            ) : null}
            <ChevronRight
              className={cn("h-4 w-4 shrink-0 text-[#777] transition-transform", open && "rotate-90")}
            />
          </button>
          {open ? (
            <ul data-activity-steps className="m-0 list-none p-0">
              {piece.steps.map((step) => (
                <ActivityStep
                  key={step.id}
                  title={relativizeDisplayText(step.title, projectPath)}
                  event={step.event}
                  projectPath={projectPath}
                />
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ActivityStep({
  title,
  event,
  projectPath,
}: {
  title: string;
  event: ToolCallEvent;
  projectPath: string;
}) {
  const summary = relativizeDisplayText(event.summary, projectPath).trim();
  const detail = relativizeDisplayText(event.detail ?? "", projectPath).trim();
  const images = event.images ?? [];
  const summaryShown = summary.length > 0 && summary !== title;
  const hasBody = summaryShown || detail.length > 0 || images.length > 0;
  const copyText = [event.name, summary, detail].filter((part) => part.trim()).join("\n");

  return (
    <li className="border-t border-[#2a2a2a]" data-activity-step data-step-title={title}>
      <div className="flex min-w-0 items-center gap-2.5 px-3 py-2 text-[13px] text-[#cfcfcf]">
        <span className="h-1 w-1 shrink-0 rounded-full bg-[#8a8a8a]" />
        <span className="min-w-0 flex-1 truncate">{title}</span>
      </div>
      {hasBody ? (
        <div data-activity-body className="min-w-0 overflow-x-hidden px-3 pb-2 pl-7 font-mono text-xs">
          {summaryShown ? <p className="break-all whitespace-pre-wrap text-zinc-300">{summary}</p> : null}
          {detail ? (
            <p className={cn("break-all whitespace-pre-wrap text-zinc-400", summaryShown && "mt-1")}>{detail}</p>
          ) : null}
          <EventImages
            paths={images}
            className="max-h-40 max-w-[160px] rounded-lg object-contain"
            frameClassName="mt-1 flex min-w-0 flex-wrap gap-1.5 overflow-x-hidden"
          />
          {copyText ? (
            <div className="mt-1 flex justify-end">
              <CopyButton text={copyText} />
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
