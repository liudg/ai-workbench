import { useState } from "react";

import { formatTokens } from "@/shared/format/tokens";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import type { SessionUsageView } from "@/store/session-usage";

const numberFormat = new Intl.NumberFormat("zh-CN");

/** 会话顶栏右侧的累计 token。没有数据就不渲染。 */
export function SessionUsageMeter({ usage }: { usage: SessionUsageView | null }) {
  const [open, setOpen] = useState(false);
  if (!usage) return null;
  const rows = breakdown(usage);
  return (
    <span
      className="relative inline-flex shrink-0"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <span
        data-session-usage
        tabIndex={0}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className="cursor-default rounded-md px-1.5 py-0.5 text-[12px] tabular-nums text-wb-fg-2 outline-none transition-colors hover:bg-wb-hover hover:text-wb-fg focus-visible:bg-wb-hover"
      >
        {formatTokens(usage.total)} tokens
      </span>
      {open && rows.length > 0 ? (
        <span
          role="tooltip"
          data-session-usage-breakdown
          className="wb-popover pointer-events-none absolute right-0 top-full z-50 mt-1.5 flex min-w-[168px] flex-col gap-1.5 rounded-xl px-3 py-2.5 text-[12px]"
        >
          {rows.map((row) => (
            <span key={row.id} data-usage-row={row.id} className="flex items-baseline justify-between gap-4">
              <span className="text-wb-fg-2">{row.label}</span>
              <span className="tabular-nums text-wb-fg">{numberFormat.format(row.value)}</span>
            </span>
          ))}
        </span>
      ) : null}
    </span>
  );
}

function breakdown(usage: SessionUsageView): { id: string; label: string; value: number }[] {
  const rows: { id: string; label: string; value: number }[] = [];
  if (usage.input !== undefined) rows.push({ id: "input", label: DESKTOP_ZH.usageInput, value: usage.input });
  if (usage.output !== undefined) rows.push({ id: "output", label: DESKTOP_ZH.usageOutput, value: usage.output });
  if (usage.cacheRead !== undefined) {
    rows.push({ id: "cache-read", label: DESKTOP_ZH.usageCacheRead, value: usage.cacheRead });
  }
  if (usage.cacheWrite !== undefined) {
    rows.push({ id: "cache-write", label: DESKTOP_ZH.usageCacheWrite, value: usage.cacheWrite });
  }
  return rows;
}
