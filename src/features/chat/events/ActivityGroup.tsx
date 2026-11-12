import { useState } from "react";
import { ChevronRight, LayoutGrid, Loader2, Search } from "lucide-react";

import { cn } from "@/lib/utils";
import { relativizeDisplayText } from "@/shared/path";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import type { Session } from "@/types";
import type { ActivityPiece, ToolCallEvent } from "./activity-fold";
import { toolFailureText, toolState, type ToolState } from "./tool-status";
import { ToolOutput } from "./ToolOutput";
import { useSessionProjectPath } from "./use-session-project-path";

type ToolPiece = Extract<ActivityPiece, { type: "tools" }>;

/**
 * 一组相邻工具的摘要行。默认一行。点开后按时间顺序列出每一步的标题，
 * 每一步再点开才看到命令和输出。还在跑的步骤转圈，失败的标红。
 * `live` 为假时，适配器留下的进行中不再转圈。
 */
export function ActivityGroup({
  piece,
  session,
  open,
  live,
  onToggle,
}: {
  piece: ToolPiece;
  session: Session;
  open: boolean;
  live: boolean;
  onToggle: () => void;
}) {
  const projectPath = useSessionProjectPath(session);
  const states = piece.steps.map((step) => toolState(step.event, live));
  const running = states.includes("running");
  const failed = states.filter((state) => state === "failed").length;

  return (
    <div
      className="event-in min-w-0 px-6 py-1"
      data-activity-group
      data-activity-summary={piece.summary}
      data-activity-running={running ? "true" : undefined}
    >
      <div className="min-w-0 pl-6">
        <div className="overflow-hidden rounded-xl border border-wb-border bg-wb-elev">
          <button
            type="button"
            data-activity-toggle
            data-expanded={open ? "true" : "false"}
            aria-expanded={open}
            title={piece.summary}
            onClick={onToggle}
            className="flex w-full min-w-0 items-center gap-2.5 px-3 py-2 text-left text-[13px] text-wb-fg-2 transition-colors hover:bg-wb-hover hover:text-wb-fg"
          >
            {running ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-wb-accent motion-reduce:animate-none" />
            ) : (
              <LayoutGrid className="h-3.5 w-3.5 shrink-0 text-wb-fg-3" />
            )}
            <span className="min-w-0 flex-1 truncate">{piece.summary}</span>
            {failed > 0 ? (
              <span data-activity-failed className="shrink-0 text-[12px] text-wb-danger">
                {DESKTOP_ZH.toolFailedCount.replace("{count}", String(failed))}
              </span>
            ) : null}
            {piece.webSearch ? (
              <span className="inline-flex shrink-0 items-center gap-1 text-[12px] text-wb-fg-3">
                <Search className="h-3.5 w-3.5" />
                {DESKTOP_ZH.activitySearchedWeb}
              </span>
            ) : null}
            <ChevronRight
              className={cn("h-4 w-4 shrink-0 text-wb-dim transition-transform", open && "rotate-90")}
            />
          </button>
          {open ? (
            <ul data-activity-steps className="m-0 list-none p-0">
              {piece.steps.map((step, index) => (
                <ActivityStep
                  key={step.id}
                  title={relativizeDisplayText(step.title, projectPath)}
                  event={step.event}
                  state={states[index]}
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
  state,
  projectPath,
}: {
  title: string;
  event: ToolCallEvent;
  state: ToolState;
  projectPath: string;
}) {
  const [open, setOpen] = useState(false);
  const summary = relativizeDisplayText(event.summary, projectPath).trim();
  const detail = relativizeDisplayText(event.detail ?? "", projectPath).trim();
  const images = event.images ?? [];
  const summaryShown = summary.length > 0 && summary !== title;
  const hasBody = summaryShown || detail.length > 0 || images.length > 0;
  const copyText = [event.name, summary, detail].filter((part) => part.trim()).join("\n");
  const failure = state === "failed" ? toolFailureText(event) : null;

  return (
    <li className="border-t border-wb-border" data-activity-step data-step-title={title} data-step-state={state}>
      <button
        type="button"
        data-step-toggle
        aria-expanded={hasBody ? open : undefined}
        disabled={!hasBody}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full min-w-0 items-center gap-2.5 px-3 py-2 text-left text-[13px] text-wb-fg-2 transition-colors enabled:hover:bg-wb-hover enabled:hover:text-wb-fg disabled:cursor-default"
      >
        <StepMark state={state} />
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {failure ? <span className="shrink-0 text-[12px] text-wb-danger">{failure}</span> : null}
        {hasBody ? (
          <ChevronRight
            className={cn("h-3.5 w-3.5 shrink-0 text-wb-dim transition-transform duration-150", open && "rotate-90")}
          />
        ) : null}
      </button>
      {open && hasBody ? (
        <div data-activity-body className="min-w-0 overflow-x-hidden px-3 pb-2 pl-7">
          <ToolOutput
            command={summaryShown ? summary : ""}
            output={detail}
            images={images}
            copyText={copyText}
            running={state === "running"}
          />
        </div>
      ) : null}
    </li>
  );
}

function StepMark({ state }: { state: ToolState }) {
  if (state === "running") {
    return <Loader2 className="h-3 w-3 shrink-0 animate-spin text-wb-accent motion-reduce:animate-none" />;
  }
  return (
    <span className="flex h-3 w-3 shrink-0 items-center justify-center">
      <span className={cn("h-1.5 w-1.5 rounded-full", state === "failed" ? "bg-wb-danger" : "bg-wb-dim")} />
    </span>
  );
}
