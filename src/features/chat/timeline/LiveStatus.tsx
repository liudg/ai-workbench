import { formatElapsed } from "./timeline";
import { useElapsedSince } from "./useElapsedSince";

/**
 * 时间线最底下的一行：进行中的这一轮此刻在做什么，以及跑了多久。
 * 只要这一轮还在跑就一直在，不管是在思考、跑命令还是输出答复，也不管过程收没收起；
 * 放在变更卡之后，眼睛停在底部就能看到。这一轮结束后整行不留。
 * 照 t3code `TimelineWorkGroupRows.tsx` 的 `WorkingTimelineRow`，以及 orca `NativeChatToolRun.tsx` 的 `latestCallLabel`。
 */
export function LiveStatus({ label, startedAt }: { label: string; startedAt: number | null }) {
  const elapsed = useElapsedSince(startedAt);
  return (
    <div className="event-in min-w-0 px-6 py-1" data-live-status data-live-label={label}>
      <p className="flex min-w-0 items-baseline gap-2 pl-6 text-[13px]">
        <span className="live-shimmer min-w-0 truncate">{label}</span>
        {elapsed != null ? (
          <span data-live-elapsed className="shrink-0 tabular-nums text-[12px] text-[#6f6f6f]">
            {formatElapsed(elapsed)}
          </span>
        ) : null}
      </p>
    </div>
  );
}
