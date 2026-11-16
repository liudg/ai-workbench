import { useEffect, useRef, useState, type ReactNode } from "react";
import { Pause, Pencil, Play, Trash2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { displayedElapsed, formatElapsed, type GoalStatusModel } from "./goal-status";

/** 目标模式时贴在作曲栏卡片上方。文案和用量来自当前会话的目标快照。 */
export function GoalStatusBar({
  model,
  disabled = false,
  onDelete,
  onToggleRun,
  onEdit,
}: {
  model: GoalStatusModel;
  disabled?: boolean;
  onDelete: () => void;
  onToggleRun: () => void;
  onEdit: () => void;
}) {
  const elapsed = useTickingSeconds(model.elapsedSeconds, model.ticking);
  const metric = model.usage ?? (elapsed != null ? formatElapsed(elapsed) : null);
  const ongoing = model.run === "pause";
  return (
    <div
      data-goal-status
      data-goal-label={model.label}
      data-goal-metric={metric ?? ""}
      data-goal-running={ongoing ? "true" : "false"}
      className="mb-2 flex min-h-10 min-w-0 items-center gap-2 rounded-xl border border-wb-border bg-wb-elev py-1.5 pl-3 pr-1.5"
    >
      <GoalMark ongoing={ongoing} />
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="shrink-0 text-sm font-medium leading-5 text-wb-fg">{model.label}</span>
        {model.objective ? (
          <span className="min-w-0 truncate text-sm leading-5 text-wb-fg-2" title={model.objective}>
            {model.objective}
          </span>
        ) : null}
        {metric ? <span className="shrink-0 text-sm leading-5 text-wb-fg-3">· {metric}</span> : null}
      </div>
      {model.actionable ? (
        <div className="flex shrink-0 items-center gap-0.5">
          {model.run ? (
            <GoalIconButton
              label={model.run === "pause" ? DESKTOP_ZH.goalPause : DESKTOP_ZH.goalResume}
              action={model.run}
              disabled={disabled}
              onClick={onToggleRun}
            >
              {model.run === "pause" ? (
                <Pause className="h-3.5 w-3.5" strokeWidth={1.75} />
              ) : (
                <Play className="h-3.5 w-3.5" strokeWidth={1.75} />
              )}
            </GoalIconButton>
          ) : null}
          <GoalIconButton label={DESKTOP_ZH.goalEdit} action="edit" disabled={disabled} onClick={onEdit}>
            <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} />
          </GoalIconButton>
          <GoalIconButton label={DESKTOP_ZH.goalDelete} action="delete" danger disabled={disabled} onClick={onDelete}>
            <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
          </GoalIconButton>
        </div>
      ) : null}
    </div>
  );
}

function GoalMark({ ongoing }: { ongoing: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={cn("h-4 w-4 shrink-0 text-wb-accent", ongoing && "animate-spin motion-reduce:animate-none")}
      aria-hidden
    >
      <circle
        cx="8"
        cy="8"
        r="5.25"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        opacity={ongoing ? 0.3 : 0.85}
      />
      {ongoing ? (
        <path
          d="M8 2.75a5.25 5.25 0 0 1 4.55 2.6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      ) : null}
    </svg>
  );
}

function GoalIconButton({
  label,
  action,
  danger = false,
  disabled,
  onClick,
  children,
}: {
  label: string;
  action: string;
  danger?: boolean;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      data-goal-action={action}
      disabled={disabled}
      className={cn(
        "flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-wb-fg-2 transition-colors disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent",
        danger ? "hover:bg-wb-danger-soft hover:text-wb-danger" : "hover:bg-wb-hover hover:text-wb-fg",
      )}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      {children}
    </button>
  );
}

function useTickingSeconds(base: number | null, ticking: boolean): number | null {
  const [now, setNow] = useState(() => Date.now());
  const anchor = useRef({ base, at: Date.now() });
  if (anchor.current.base !== base) anchor.current = { base, at: Date.now() };
  useEffect(() => {
    if (base == null || !ticking) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [base, ticking]);
  if (base == null) return null;
  return displayedElapsed(base, ticking, anchor.current.at, ticking ? now : anchor.current.at);
}
