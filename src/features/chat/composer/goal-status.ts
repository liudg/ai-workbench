import { DESKTOP_ZH } from "../../../shared/strings/desktop-zh.ts";
import type { GoalSnapshot } from "./goal.ts";

/** Codex TUI `goal_status_indicator_line`。没有用量数字时不补 0。 */
export function goalStatusLine(goal: GoalSnapshot | null, drafting: boolean): string | null {
  if (!goal && !drafting) return null;
  if (!goal) return DESKTOP_ZH.goalHint;
  const usage = goalUsage(goal);
  switch (goal.status) {
    case "paused":
      return DESKTOP_ZH.goalStatusPaused;
    case "blocked":
      return DESKTOP_ZH.goalStatusBlocked;
    case "usageLimited":
      return DESKTOP_ZH.goalStatusUsageLimited;
    case "budgetLimited":
      return usage ? `${DESKTOP_ZH.goalStatusUnmet} (${usage})` : DESKTOP_ZH.goalStatusAbandoned;
    case "complete":
      return usage ? `${DESKTOP_ZH.goalStatusComplete} (${usage})` : DESKTOP_ZH.goalStatusComplete;
    default:
      return usage ? `${DESKTOP_ZH.goalStatusActive} (${usage})` : DESKTOP_ZH.goalStatusActive;
  }
}

function goalUsage(goal: GoalSnapshot): string | null {
  if (goal.status === "budgetLimited") return budgetUsage(goal);
  if (goal.status === "complete") return completeUsage(goal);
  if (goal.status !== "active") return null;
  if (goal.tokenBudget != null) {
    return `${formatTokens(goal.tokensUsed ?? 0)} / ${formatTokens(goal.tokenBudget)}`;
  }
  // 没有 token 预算时 TUI 一律显示已用时间。字段没来就不补 0。
  if (goal.timeUsedSeconds != null) return formatElapsed(goal.timeUsedSeconds);
  return null;
}

function budgetUsage(goal: GoalSnapshot): string | null {
  if (goal.tokenBudget == null) return null;
  return `${formatTokens(goal.tokensUsed ?? 0)} / ${formatTokens(goal.tokenBudget)} tokens`;
}

function completeUsage(goal: GoalSnapshot): string | null {
  if (goal.tokenBudget != null) return `${formatTokens(goal.tokensUsed ?? 0)} tokens`;
  if (goal.timeUsedSeconds != null) return formatElapsed(goal.timeUsedSeconds);
  return null;
}

/** TUI `format_tokens_compact`：12500 → 12.5K，50000 → 50K，63876 → 63.9K。 */
export function formatTokens(value: number): string {
  const abs = Math.max(0, Math.floor(Math.abs(value)));
  if (abs === 0) return "0";
  if (abs < 1_000) return String(abs);
  const units = [
    { scale: 1_000_000_000_000, suffix: "T" },
    { scale: 1_000_000_000, suffix: "B" },
    { scale: 1_000_000, suffix: "M" },
    { scale: 1_000, suffix: "K" },
  ];
  const unit = units.find((item) => abs >= item.scale) ?? units[units.length - 1]!;
  const scaled = abs / unit.scale;
  const decimals = scaled < 10 ? 2 : scaled < 100 ? 1 : 0;
  let formatted = scaled.toFixed(decimals);
  if (formatted.includes(".")) formatted = formatted.replace(/0+$/, "").replace(/\.$/, "");
  return `${formatted}${unit.suffix}`;
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
