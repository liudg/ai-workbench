import type { SessionStatus, SubscriptionUsage, SubscriptionWindow } from "@/types";

const DAY_SECONDS = 86_400;
const HOUR_SECONDS = 3_600;
const MINUTE_SECONDS = 60;

function finite(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/** 剩余百分比。有 remaining 用它，否则用 100 减已用。两个都没有就不参与比较。 */
export function remainingPercent(window: SubscriptionWindow): number | null {
  const remaining = finite(window.remaining_percent);
  if (remaining !== null) return clampPercent(remaining);
  const used = finite(window.used_percent);
  if (used !== null) return clampPercent(100 - used);
  return null;
}

/** 最紧的窗口：剩余最低。相同剩余时，更早重置的优先。 */
export function pickTightestWindow(windows: readonly SubscriptionWindow[]): SubscriptionWindow | null {
  let best: SubscriptionWindow | null = null;
  let bestRemaining = Infinity;
  let bestReset = Infinity;
  for (const window of windows) {
    const remaining = remainingPercent(window);
    if (remaining === null) continue;
    const reset = finite(window.resets_at_ms) ?? Infinity;
    if (remaining < bestRemaining || (remaining === bestRemaining && reset < bestReset)) {
      best = window;
      bestRemaining = remaining;
      bestReset = reset;
    }
  }
  return best;
}

/** 距重置还有多久。有天时写成 NdNh，否则 NhNm、Nm 或 Ns。 */
export function formatResetWait(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / DAY_SECONDS);
  const hours = Math.floor((total % DAY_SECONDS) / HOUR_SECONDS);
  const minutes = Math.floor((total % HOUR_SECONDS) / MINUTE_SECONDS);
  const seconds = total % MINUTE_SECONDS;
  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

export function formatSubscriptionHeadline(window: SubscriptionWindow, now: number): string | null {
  const remaining = remainingPercent(window);
  if (remaining === null) return null;
  const percent = Math.round(remaining);
  const reset = finite(window.resets_at_ms);
  if (reset === null) return `剩 ${percent}%`;
  if (reset <= now) return `剩 ${percent}% · 即将重置`;
  return `剩 ${percent}% · ${formatResetWait(reset - now)} 后重置`;
}

export function subscriptionTone(remaining: number): "critical" | "warning" | "normal" {
  const shown = Math.round(remaining);
  if (shown <= 5) return "critical";
  if (shown <= 20) return "warning";
  return "normal";
}

/** 回合从运行中进入完成、失败或停止时刷新。停在需要输入时不刷新。 */
export function shouldRefreshAfterStatus(
  previous: SessionStatus | undefined,
  next: SessionStatus | undefined,
): boolean {
  if (previous !== "running") return false;
  return next === "completed" || next === "failed" || next === "stopped";
}

/**
 * 预览地址里的窗口。`标签:used|remaining:百分比[:unix秒]`，多个用逗号分开。
 * 不把真实账号额度写进源码。
 */
export function parseSubscriptionSeed(raw: string): SubscriptionUsage | null {
  const windows: SubscriptionWindow[] = [];
  for (const part of raw.split(",")) {
    const bits = part.trim().split(":");
    if (bits.length < 3) continue;
    const label = bits[0]?.trim() ?? "";
    const kind = bits[1];
    const percent = Number(bits[2]);
    if (!label || (kind !== "used" && kind !== "remaining") || !Number.isFinite(percent)) continue;
    const window: SubscriptionWindow = { id: label, label };
    if (kind === "used") window.used_percent = percent;
    else window.remaining_percent = percent;
    if (bits[3]) {
      const seconds = Number(bits[3]);
      if (Number.isFinite(seconds)) window.resets_at_ms = Math.round(seconds * 1000);
    }
    windows.push(window);
  }
  return windows.length > 0 ? { windows } : null;
}
