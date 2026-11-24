import { useCallback, useEffect, useState } from "react";
import { ChevronRight, LayoutGrid, Loader2, Search } from "lucide-react";

import { cn } from "@/lib/utils";
import { relativizeDisplayText } from "@/shared/path";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import type { Session } from "@/types";
import { useChatHost } from "../host";
import { formatElapsed } from "../timeline/timeline";
import { useElapsedSince } from "../timeline/useElapsedSince";
import type { ActivityPiece, ToolCallEvent } from "./activity-fold";
import {
  resolveBackgroundOutput,
  toolStreamKey,
  type BackgroundTaskEvent,
} from "./background-task-display";
import { toolFailureText, toolState, type ToolState } from "./tool-status";
import { ToolOutput } from "./ToolOutput";
import { useEventAgent } from "./use-agent-identity";
import { useBackgroundOutput } from "./useBackgroundOutput";
import { useSessionProjectPath } from "./use-session-project-path";

type ToolPiece = Extract<ActivityPiece, { type: "tools" }>;

/**
 * 一组相邻工具的摘要行。默认一行。点开后按时间顺序列出每一步的标题，
 * 每一步再点开才看到命令和输出。还在跑的步骤转圈，失败的标红。
 * 关联了后台任务的步骤跟后台任务状态走，跨回合仍在跑继续转圈。
 */
export function ActivityGroup({
  piece,
  session,
  open,
  live,
  backgroundByToolCall,
  revealEventId,
  onToggle,
}: {
  piece: ToolPiece;
  session: Session;
  open: boolean;
  live: boolean;
  backgroundByToolCall?: ReadonlyMap<string, BackgroundTaskEvent>;
  revealEventId?: string | null;
  onToggle: () => void;
}) {
  const projectPath = useSessionProjectPath(session);
  const backgrounds = piece.steps.map((step) => {
    const streamId = step.event.stream_id?.trim();
    return streamId
      ? backgroundByToolCall?.get(toolStreamKey(step.event.session_id, streamId))
      : undefined;
  });
  const states = piece.steps.map((step, index) => toolState(step.event, live, backgrounds[index]));
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
            className={cn(
              "flex w-full min-w-0 items-center gap-2.5 px-3 py-2 text-left text-[13px] transition-colors",
              open
                ? "bg-wb-card font-semibold text-wb-fg"
                : "text-wb-fg-2 hover:bg-wb-hover hover:text-wb-fg",
            )}
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
                  title={step.title}
                  event={step.event}
                  session={session}
                  state={states[index]}
                  background={backgrounds[index]}
                  projectPath={projectPath}
                  reveal={revealEventId === step.event.id}
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
  session,
  state,
  background,
  projectPath,
  reveal = false,
}: {
  title: string;
  event: ToolCallEvent;
  session: Session;
  state: ToolState;
  background?: BackgroundTaskEvent;
  projectPath: string;
  reveal?: boolean;
}) {
  const [open, setOpen] = useState(reveal);
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    if (reveal) setOpen(true);
  }, [reveal]);
  const host = useChatHost();
  const agent = useEventAgent(event, session);

  const readTaskOutput = host.readTaskOutput;
  const readForSession = useCallback(
    (path: string) => (readTaskOutput ? readTaskOutput(event.session_id, path) : Promise.resolve("")),
    [event.session_id, readTaskOutput],
  );
  const readableFile = Boolean(background?.output_file?.trim() && readTaskOutput);
  const fileState = useBackgroundOutput(
    background,
    open,
    readableFile ? readForSession : undefined,
  );

  const summary = relativizeDisplayText(event.summary, projectPath).trim();
  const rawOutput = background
    ? resolveBackgroundOutput({
        detail: event.detail,
        fileText: fileState.text,
        // 首次读 `output_file` 未返回前先不闪出 `result` 英文回执。
        result: readableFile && !fileState.settled ? "" : background.result,
        rawTitle: background.title,
      })
    : (event.detail ?? "");
  const detail = relativizeDisplayText(rawOutput, projectPath).trim();
  const images = event.images ?? [];
  const summaryShown = summary.length > 0 && summary !== title;
  const canStop = Boolean(
    background?.status === "running" &&
      background.session_id === session.id &&
      host.profiles[agent]?.capabilities.supports_background_task_stop &&
      host.stopBackgroundTask,
  );
  const hasVisibleContent = summaryShown || detail.length > 0 || images.length > 0;
  const placeholder = !hasVisibleContent
    ? fileState.loading
      ? DESKTOP_ZH.filesReading
      : background && state === "running"
        ? DESKTOP_ZH.backgroundWaitingOutput
        : undefined
    : undefined;
  const canExpand =
    hasVisibleContent ||
    Boolean(placeholder) ||
    canStop ||
    (readableFile && !fileState.settled);

  if (open && !canExpand) {
    setOpen(false);
  }
  const shownOpen = (open || reveal) && canExpand;

  const copyText =
    summaryShown || detail
      ? [event.name, summary, detail].filter((part) => part.trim()).join("\n")
      : "";
  const failure = state === "failed" ? toolFailureText(event, background) : null;

  const stop = () => {
    if (!background || !host.stopBackgroundTask || stopping) return;
    setStopping(true);
    void host.stopBackgroundTask(background.session_id, background.task_id).finally(() => {
      setStopping(false);
    });
  };

  return (
    <li className="border-t border-wb-border" data-activity-step data-step-title={title} data-step-state={state}>
      <button
        type="button"
        data-step-toggle
        aria-expanded={canExpand ? shownOpen : undefined}
        disabled={!canExpand}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full min-w-0 items-center gap-2.5 px-3 py-2 text-left text-[13px] text-wb-fg-2 transition-colors enabled:hover:bg-wb-hover enabled:hover:text-wb-fg disabled:cursor-default"
      >
        <StepMark state={state} />
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {background?.status === "running" ? (
          <BackgroundRunningTag startedAt={background.started_at ?? null} />
        ) : state === "stopped" ? (
          <span data-step-background="stopped" className="shrink-0 text-[12px] text-wb-fg-3">
            {DESKTOP_ZH.backgroundStopped}
          </span>
        ) : failure ? (
          <span className="shrink-0 text-[12px] text-wb-danger">{failure}</span>
        ) : null}
        {canExpand ? (
          <ChevronRight
            className={cn("h-3.5 w-3.5 shrink-0 text-wb-dim transition-transform duration-150", shownOpen && "rotate-90")}
          />
        ) : null}
      </button>
      {shownOpen ? (
        <div data-activity-body className="min-w-0 overflow-x-hidden px-3 pb-2.5 pl-9">
          <ToolOutput
            command={summaryShown ? summary : ""}
            output={detail}
            placeholder={placeholder}
            images={images}
            copyText={copyText}
            running={state === "running"}
            onStop={canStop ? stop : undefined}
            stopping={stopping}
          />
        </div>
      ) : null}
    </li>
  );
}

function BackgroundRunningTag({ startedAt }: { startedAt: number | null }) {
  const elapsed = useElapsedSince(startedAt);
  return (
    <span data-step-background="running" className="shrink-0 tabular-nums text-[12px] text-wb-fg-3">
      {elapsed != null ? `${DESKTOP_ZH.backgroundRunning} · ${formatElapsed(elapsed)}` : DESKTOP_ZH.backgroundRunning}
    </span>
  );
}

function StepMark({ state }: { state: ToolState }) {
  if (state === "running") {
    return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-wb-accent motion-reduce:animate-none" />;
  }
  return (
    <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          state === "failed" ? "bg-wb-danger" : "bg-wb-dim",
        )}
      />
    </span>
  );
}
