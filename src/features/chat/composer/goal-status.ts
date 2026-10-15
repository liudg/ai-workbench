import { formatTokens } from "../../../shared/format/tokens.ts";
import { DESKTOP_ZH } from "../../../shared/strings/desktop-zh.ts";
import type { GoalSnapshot } from "./goal.ts";

export { formatTokens };

export interface GoalStatusModel {
  /** 粗体状态，例如「进行中的目标」。还在写草稿时是整句提示。 */
  label: string;
  /** 已提交的目标原文。 */
  objective: string | null;
  /** token 用量。有预算时优先于计时。没有就不显示，不补 0。 */
  usage: string | null;
  /** 服务端已用秒数。没有预算、且字段来了才显示。 */
  elapsedSeconds: number | null;
  /** 进行中才在两次快照之间按本地秒往前走。 */
  ticking: boolean;
  /** 暂停键或继续键。完成和预算用尽时没有。 */
  run: "pause" | "resume" | null;
  /** 已提交的目标才能删除、暂停、编辑。 */
  actionable: boolean;
}

/** 目标状态栏要画的结构。没有目标、也不是草稿时不出现。 */
export function goalStatusModel(goal: GoalSnapshot | null, drafting: boolean): GoalStatusModel | null {
  if (!goal && !drafting) return null;
  if (!goal) {
    return {
      label: DESKTOP_ZH.goalHint,
      objective: null,
      usage: null,
      elapsedSeconds: null,
      ticking: false,
      run: null,
      actionable: false,
    };
  }
  const usage = tokenMetric(goal);
  const elapsedSeconds = usage == null ? goal.timeUsedSeconds : null;
  return {
    label: goalLabel(goal),
    objective: goal.objective,
    usage,
    elapsedSeconds,
    ticking: elapsedSeconds != null && goal.status === "active",
    run: runControl(goal.status),
    actionable: true,
  };
}

/** 进行中的计时。不在进行中时停在服务端给的秒数。 */
export function displayedElapsed(baseSeconds: number, ticking: boolean, startedAtMs: number, nowMs: number): number {
  const base = Math.max(0, Math.floor(baseSeconds));
  if (!ticking) return base;
  const extra = Math.floor(Math.max(0, nowMs - startedAtMs) / 1000);
  return base + extra;
}

function goalLabel(goal: GoalSnapshot): string {
  switch (goal.status) {
    case "paused":
      return DESKTOP_ZH.goalStatusPaused;
    case "blocked":
      return DESKTOP_ZH.goalStatusBlocked;
    case "usageLimited":
      return DESKTOP_ZH.goalStatusUsageLimited;
    case "budgetLimited":
      return goal.tokenBudget == null ? DESKTOP_ZH.goalStatusAbandoned : DESKTOP_ZH.goalStatusUnmet;
    case "complete":
      return DESKTOP_ZH.goalStatusComplete;
    default:
      return DESKTOP_ZH.goalStatusActive;
  }
}

function runControl(status: string): "pause" | "resume" | null {
  if (status === "paused" || status === "blocked" || status === "usageLimited") return "resume";
  if (status === "complete" || status === "budgetLimited") return null;
  return "pause";
}

function tokenMetric(goal: GoalSnapshot): string | null {
  if (goal.status === "budgetLimited") return budgetUsage(goal);
  if (goal.status === "complete") return completeUsage(goal);
  if (goal.tokenBudget == null) return null;
  return `${formatTokens(goal.tokensUsed ?? 0)} / ${formatTokens(goal.tokenBudget)}`;
}

function budgetUsage(goal: GoalSnapshot): string | null {
  if (goal.tokenBudget == null) return null;
  return `${formatTokens(goal.tokensUsed ?? 0)} / ${formatTokens(goal.tokenBudget)} tokens`;
}

function completeUsage(goal: GoalSnapshot): string | null {
  if (goal.tokenBudget != null) return `${formatTokens(goal.tokensUsed ?? 0)} tokens`;
  return null;
}

/** TUI `format_goal_elapsed_seconds`：120 → 2m，36720 → 10h 12m。不满一分钟的余数丢掉。 */
export function formatElapsed(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    return `${days}d ${remainingHours}h ${remainingMinutes}m`;
  }
  if (remainingMinutes === 0) return `${hours}h`;
  return `${hours}h ${remainingMinutes}m`;
}
