import { useEffect, useRef, useState, type ReactNode } from "react";
import { Pause, Play, Trash2 } from "lucide-react";

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
      className="mb-2 flex min-h-10 min-w-0 items-center gap-2 rounded-2xl border border-[#2a2a2a] bg-[#171717] py-1.5 pl-3 pr-1.5"
    >
      <GoalMark ongoing={ongoing} />
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="shrink-0 text-sm font-semibold leading-5 text-[#f4f4f5]">{model.label}</span>
        {model.objective ? (
          <span className="min-w-0 truncate text-sm leading-5 text-[#9a9a9a]" title={model.objective}>
            {model.objective}
          </span>
        ) : null}
        {metric ? <span className="shrink-0 text-sm leading-5 text-[#9a9a9a]">· {metric}</span> : null}
      </div>
      {model.actionable ? (
        <div className="flex shrink-0 items-center">
          <GoalIconButton label={DESKTOP_ZH.goalDelete} action="delete" disabled={disabled} onClick={onDelete}>
            <Trash2 className="h-4 w-4" strokeWidth={1.75} />
          </GoalIconButton>
          {model.run ? (
            <GoalIconButton
              label={model.run === "pause" ? DESKTOP_ZH.goalPause : DESKTOP_ZH.goalResume}
              action={model.run}
              disabled={disabled}
              onClick={onToggleRun}
            >
              {model.run === "pause" ? (
                <Pause className="h-4 w-4" strokeWidth={1.75} />
              ) : (
                <Play className="h-4 w-4" strokeWidth={1.75} />
              )}
            </GoalIconButton>
          ) : null}
          <GoalIconButton label={DESKTOP_ZH.goalEdit} action="edit" disabled={disabled} onClick={onEdit}>
            <GoalEditIcon />
          </GoalIconButton>
        </div>
      ) : null}
    </div>
  );
}

function GoalMark({ ongoing }: { ongoing: boolean }) {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4 shrink-0 text-[#b5b5b5]" aria-hidden>
      <circle
        cx="8"
        cy="8"
        r="5.25"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        opacity={ongoing ? 0.35 : 0.85}
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

function GoalEditIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M6.25 3.25H3.75V5.75" />
      <path d="M9.75 3.25h2.5V5.75" />
      <path d="M12.25 10.25v2.5H9.75" />
      <path d="M6.25 12.75H3.75V10.25" />
    </svg>
  );
}

function GoalIconButton({
  label,
  action,
  disabled,
  onClick,
  children,
}: {
  label: string;
  action: string;
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
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[#a3a3a3] hover:bg-white/10 hover:text-[#f4f4f5] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
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
