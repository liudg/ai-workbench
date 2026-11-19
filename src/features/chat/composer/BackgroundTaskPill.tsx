import { useCallback, useMemo, useRef, useState } from "react";
import { Loader2, Square } from "lucide-react";

import { cn } from "@/lib/utils";
import { relativizeDisplayText } from "@/shared/path";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import type { ToolCallEvent } from "../events/activity-fold";
import {
  backgroundStatusLabel,
  backgroundTaskTitle,
  linkedToolForTask,
  resolveBackgroundOutput,
  visiblePillTasks,
  type BackgroundTaskEvent,
} from "../events/background-task-display";
import { outputPreview } from "../events/tool-output";
import { useBackgroundOutput } from "../events/useBackgroundOutput";
import { useFollowBottom } from "../events/useFollowBottom";
import { formatElapsed } from "../timeline/timeline";
import { useElapsedSince } from "../timeline/useElapsedSince";
import { useComposerMenu } from "./useComposerMenu";

const EMPTY_SET: ReadonlySet<string> = new Set();

export interface BackgroundPillState {
  visible: boolean;
  open: boolean;
  running: readonly BackgroundTaskEvent[];
  shown: readonly BackgroundTaskEvent[];
  toggle: () => void;
  close: () => void;
}

/**
 * 统一管理胶囊显隐、浮层开关与打开期间保留的任务集合：
 * - 浮层打开期间新启动的任务自动并入保留集合，停止后不会从光标下消失；
 * - 事件清空或无可展示任务时自动复位 `open`，不留无浮层的孤立胶囊。
 */
export function useBackgroundPill(tasks: readonly BackgroundTaskEvent[]): BackgroundPillState {
  const [open, setOpen] = useState(false);
  const [pinnedIds, setPinnedIds] = useState<ReadonlySet<string>>(EMPTY_SET);

  const running = useMemo(() => tasks.filter((task) => task.status === "running"), [tasks]);

  if (open) {
    let missing = false;
    for (const task of running) {
      if (!pinnedIds.has(task.task_id)) {
        missing = true;
        break;
      }
    }
    if (missing) {
      const next = new Set(pinnedIds);
      for (const task of running) next.add(task.task_id);
      setPinnedIds(next);
    }
  }

  const shown = useMemo(() => visiblePillTasks(tasks, pinnedIds, open), [open, pinnedIds, tasks]);

  if (open && shown.length === 0) {
    setOpen(false);
    if (pinnedIds.size > 0) setPinnedIds(EMPTY_SET);
  }

  const effectiveOpen = open && shown.length > 0;
  const visible = running.length > 0 || effectiveOpen;

  const close = useCallback(() => {
    setPinnedIds(EMPTY_SET);
    setOpen(false);
  }, []);

  const toggle = useCallback(() => {
    if (effectiveOpen) {
      setPinnedIds(EMPTY_SET);
      setOpen(false);
      return;
    }
    setPinnedIds(new Set(running.map((task) => task.task_id)));
    setOpen(true);
  }, [effectiveOpen, running]);

  return {
    visible,
    open: effectiveOpen,
    running,
    shown,
    toggle,
    close,
  };
}

/**
 * 作曲栏顶栏右侧的 24px 后台任务胶囊。
 * 平时完全隐藏；有运行中的后台任务时出现，点击弹出轻量 `wb-popover` 查看尾部实时输出或停止。
 */
export function BackgroundTaskPill({
  pill,
  toolsByStream,
  projectPath,
  canStop,
  onBeforeOpen,
  onStop,
  readTaskOutput,
}: {
  pill: BackgroundPillState;
  toolsByStream: ReadonlyMap<string, ToolCallEvent>;
  projectPath: string;
  canStop: boolean;
  onBeforeOpen?: () => void;
  onStop?: (taskId: string) => Promise<void>;
  readTaskOutput?: (path: string) => Promise<string>;
}) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [stoppingIds, setStoppingIds] = useState<ReadonlySet<string>>(EMPTY_SET);
  const { open, running, shown, toggle, close } = pill;

  const handleToggle = () => {
    if (!open) {
      onBeforeOpen?.();
      setExpandedId((current) =>
        current && running.some((task) => task.task_id === current)
          ? current
          : (running[0]?.task_id ?? null),
      );
    }
    toggle();
  };

  useComposerMenu(
    open,
    anchorRef,
    menuRef,
    close,
    `${shown.length}:${expandedId ?? ""}`,
    "end",
  );

  if (!pill.visible) return null;

  const stopOne = (taskId: string) => {
    if (!canStop || !onStop || stoppingIds.has(taskId)) return;
    setStoppingIds((prev) => new Set(prev).add(taskId));
    void onStop(taskId).finally(() => {
      setStoppingIds((prev) => {
        if (!prev.has(taskId)) return prev;
        const next = new Set(prev);
        next.delete(taskId);
        return next;
      });
    });
  };

  const stopAll = () => {
    for (const task of running) stopOne(task.task_id);
  };

  const single = running.length === 1 ? running[0] : null;
  const singleTool = single ? linkedToolForTask(single, toolsByStream) : undefined;
  const singleTitle = single ? backgroundTaskTitle(single, singleTool, projectPath) : "";
  const ariaSummary = single
    ? singleTitle
    : running.length > 1
      ? DESKTOP_ZH.backgroundRunningCount.replace("{count}", String(running.length))
      : DESKTOP_ZH.backgroundEnded;
  const stoppableCount = canStop && onStop ? running.length : 0;
  const allStopping = running.length > 0 && running.every((task) => stoppingIds.has(task.task_id));

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        data-background-pill=""
        data-background-running={running.length}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${DESKTOP_ZH.backgroundTasks}：${ariaSummary}`}
        onClick={(event) => {
          event.stopPropagation();
          handleToggle();
        }}
        className={cn(
          "inline-flex h-6 max-w-[14.5rem] min-w-0 items-center gap-1.5 rounded-md border px-2 text-xs transition-colors",
          open
            ? "border-wb-accent/40 bg-wb-accent-soft text-wb-fg"
            : "border-wb-border bg-wb-surface/75 text-wb-fg-2 hover:border-wb-border-strong hover:bg-wb-hover hover:text-wb-fg",
        )}
      >
        {single ? (
          <SinglePillLabel task={single} title={singleTitle} />
        ) : running.length > 1 ? (
          <>
            <Loader2 className="h-3 w-3 shrink-0 animate-spin text-wb-accent motion-reduce:animate-none" />
            <span className="truncate text-wb-fg">{ariaSummary}</span>
          </>
        ) : (
          <>
            <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-wb-dim" />
            <span className="truncate text-wb-fg-3">{DESKTOP_ZH.backgroundEnded}</span>
          </>
        )}
      </button>
      {open ? (
        <div
          ref={menuRef}
          role="dialog"
          aria-label={DESKTOP_ZH.backgroundTasks}
          data-background-popover=""
          className="wb-popover fixed z-50 flex max-h-[min(22rem,calc(100vh-2rem))] w-[340px] max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-xl"
          style={{ top: -9999, left: 8 }}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="flex items-center justify-between gap-2 border-b border-wb-border px-3 py-2 text-xs">
            <span className="font-medium text-wb-fg">
              {running.length > 0
                ? `${DESKTOP_ZH.backgroundTasks} · ${running.length}`
                : DESKTOP_ZH.backgroundEnded}
            </span>
            {stoppableCount > 1 ? (
              <button
                type="button"
                data-background-stop-all=""
                disabled={allStopping}
                onClick={stopAll}
                className="rounded px-1.5 py-0.5 text-xs text-wb-fg-3 transition-colors hover:bg-wb-hover hover:text-wb-danger disabled:opacity-50"
              >
                {DESKTOP_ZH.backgroundStopAll}
              </button>
            ) : null}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {shown.map((task) => {
              const linkedTool = linkedToolForTask(task, toolsByStream);
              const expanded = expandedId === task.task_id;
              return (
                <PopoverTaskRow
                  key={task.task_id}
                  task={task}
                  linkedTool={linkedTool}
                  projectPath={projectPath}
                  expanded={expanded}
                  stopping={stoppingIds.has(task.task_id)}
                  canStop={Boolean(canStop && onStop && task.status === "running")}
                  readTaskOutput={readTaskOutput}
                  onToggle={() =>
                    setExpandedId((current) => (current === task.task_id ? null : task.task_id))
                  }
                  onStop={() => stopOne(task.task_id)}
                />
              );
            })}
          </div>
        </div>
      ) : null}
    </>
  );
}

function SinglePillLabel({
  task,
  title,
}: {
  task: BackgroundTaskEvent;
  title: string;
}) {
  const elapsed = useElapsedSince(task.started_at ?? null);
  return (
    <>
      <Loader2 className="h-3 w-3 shrink-0 animate-spin text-wb-accent motion-reduce:animate-none" />
      <span className="min-w-0 truncate text-wb-fg" title={title}>
        {title}
      </span>
      {elapsed != null ? (
        <span className="shrink-0 tabular-nums text-wb-fg-3">{formatElapsed(elapsed)}</span>
      ) : null}
    </>
  );
}

function PopoverTaskRow({
  task,
  linkedTool,
  projectPath,
  expanded,
  stopping,
  canStop,
  readTaskOutput,
  onToggle,
  onStop,
}: {
  task: BackgroundTaskEvent;
  linkedTool?: ToolCallEvent;
  projectPath: string;
  expanded: boolean;
  stopping: boolean;
  canStop: boolean;
  readTaskOutput?: (path: string) => Promise<string>;
  onToggle: () => void;
  onStop: () => void;
}) {
  const running = task.status === "running";
  const elapsed = useElapsedSince(running ? (task.started_at ?? null) : null);
  const title = backgroundTaskTitle(task, linkedTool, projectPath);
  const command = useMemo(
    () => relativizeDisplayText(linkedTool?.summary ?? "", projectPath).trim(),
    [linkedTool?.summary, projectPath],
  );
  const commandShown = command.length > 0 && command !== title;
  const readableFile = Boolean(task.output_file?.trim() && readTaskOutput);
  const fileState = useBackgroundOutput(
    task,
    expanded,
    readableFile ? readTaskOutput : undefined,
  );
  const rawOutput = useMemo(
    () =>
      resolveBackgroundOutput({
        detail: linkedTool?.detail,
        fileText: fileState.text,
        result: readableFile && !fileState.settled ? "" : task.result,
        rawTitle: task.title,
      }),
    [fileState.settled, fileState.text, linkedTool?.detail, readableFile, task.result, task.title],
  );
  const output = useMemo(
    () => relativizeDisplayText(rawOutput, projectPath).trim(),
    [projectPath, rawOutput],
  );
  const tail = useMemo(() => outputPreview(output).text, [output]);
  const follow = useFollowBottom<HTMLPreElement>(Boolean(tail), tail);

  const placeholder = !tail
    ? fileState.loading
      ? DESKTOP_ZH.filesReading
      : running
        ? DESKTOP_ZH.backgroundWaitingOutput
        : undefined
    : undefined;
  const canExpand =
    commandShown ||
    Boolean(tail) ||
    Boolean(placeholder) ||
    (readableFile && !fileState.settled);
  const shownExpanded = expanded && canExpand;
  const statusText = backgroundStatusLabel(
    task,
    elapsed != null ? formatElapsed(elapsed) : null,
  );

  return (
    <div
      data-background-row={task.task_id}
      data-background-status={task.status}
      className="border-t border-wb-border first:border-t-0"
    >
      <div className="flex min-w-0 items-center gap-2 px-3 py-2 text-xs transition-colors hover:bg-wb-hover">
        <button
          type="button"
          disabled={!canExpand}
          aria-expanded={canExpand ? shownExpanded : undefined}
          onClick={onToggle}
          title={command || title}
          className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-default"
        >
          {running ? (
            <Loader2 className="h-3 w-3 shrink-0 animate-spin text-wb-accent motion-reduce:animate-none" />
          ) : (
            <span className="flex h-3 w-3 shrink-0 items-center justify-center">
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  task.status === "failed" ? "bg-wb-danger" : "bg-wb-dim",
                )}
              />
            </span>
          )}
          <span className="min-w-0 flex-1 truncate text-wb-fg">{title}</span>
        </button>
        <span
          className={cn(
            "shrink-0 tabular-nums",
            task.status === "failed" ? "text-wb-danger" : "text-wb-fg-3",
          )}
        >
          {statusText}
        </span>
        {canStop ? (
          <button
            type="button"
            data-background-stop={task.task_id}
            title={DESKTOP_ZH.backgroundStop}
            aria-label={`${DESKTOP_ZH.backgroundStop} ${title}`}
            disabled={stopping}
            onClick={onStop}
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-wb-fg-3 transition-colors hover:bg-wb-hover hover:text-wb-danger disabled:opacity-50"
          >
            {stopping ? (
              <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" />
            ) : (
              <Square className="h-2.5 w-2.5 fill-current" />
            )}
          </button>
        ) : null}
      </div>
      {shownExpanded ? (
        <div className="space-y-1.5 px-3 pb-2.5">
          {commandShown ? (
            <p className="m-0 line-clamp-2 font-mono text-xs break-all text-wb-fg-3">{command}</p>
          ) : null}
          {tail ? (
            <pre
              ref={follow.ref}
              onScroll={follow.onScroll}
              data-own-scroll
              data-background-output={task.task_id}
              className="m-0 max-h-36 overflow-auto overscroll-contain rounded-lg border border-wb-border bg-wb-code px-2.5 py-1.5 font-mono text-xs leading-5 whitespace-pre-wrap break-all text-wb-fg-2"
            >
              {tail}
            </pre>
          ) : placeholder ? (
            <p className="m-0 rounded-lg border border-wb-border bg-wb-code px-2.5 py-1.5 text-xs text-wb-fg-3">
              {placeholder}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
