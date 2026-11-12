import { useState } from "react";

import { cn } from "@/lib/utils";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { formatSubscriptionHeadline } from "@/store/subscription-usage";
import type { AgentKind } from "@/types";
import { SessionUsageMeter } from "./SessionUsageMeter";
import { usePanel } from "./PanelProvider";
import { useSubscriptionUsage } from "./use-subscription-usage";

const TONE_CLASS = {
  normal: "text-wb-fg-2 hover:text-wb-fg",
  warning: "text-wb-warn",
  critical: "text-wb-danger",
} as const;

/** 订阅剩余和重置时间。没有窗口时不渲染。点击再拉一次，悬停列出全部窗口。 */
export function SubscriptionUsageMeter({ agent }: { agent: AgentKind | null }) {
  const { headline, windows, now, tone, remaining, refresh } = useSubscriptionUsage(agent);
  const [open, setOpen] = useState(false);
  if (!headline || remaining === null) return null;
  const rows = windows.flatMap((window) => {
    const line = formatSubscriptionHeadline(window, now);
    return line ? [{ id: window.id, label: window.label, line }] : [];
  });
  return (
    <span
      className="relative inline-flex shrink-0"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        data-subscription-usage
        data-subscription-remaining={Math.round(remaining)}
        data-subscription-tone={tone}
        aria-label={`${headline}。${DESKTOP_ZH.subscriptionUsageRefresh}`}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => refresh()}
        className={cn(
          "cursor-pointer rounded-md px-1.5 py-0.5 text-[12px] tabular-nums outline-none transition-colors hover:bg-wb-hover focus-visible:bg-wb-hover",
          TONE_CLASS[tone],
        )}
      >
        {headline}
      </button>
      {open && rows.length > 0 ? (
        <span
          role="tooltip"
          data-subscription-usage-breakdown
          className="wb-popover pointer-events-none absolute right-0 top-full z-50 mt-1.5 flex min-w-[220px] flex-col gap-1.5 rounded-xl px-3 py-2.5 text-[12px]"
        >
          {rows.map((row) => (
            <span key={row.id} data-subscription-row={row.id} className="flex items-baseline justify-between gap-4">
              <span className="text-wb-fg-2">{row.label}</span>
              <span className="tabular-nums text-wb-fg">{row.line}</span>
            </span>
          ))}
        </span>
      ) : null}
    </span>
  );
}

/** 订阅芯片在 token 用量左侧。两处顶栏共用，避免只改其中一处。 */
export function SessionUsageCluster() {
  const { usage, agent } = usePanel();
  return (
    <span className="inline-flex shrink-0 items-center">
      <SubscriptionUsageMeter agent={agent} />
      <SessionUsageMeter usage={usage} />
    </span>
  );
}
