import { useEffect, useState } from "react";

/** 从 `startedAt`（毫秒时间戳）到现在过了多久，每秒刷新一次。没有起点时为 null。 */
export function useElapsedSince(startedAt: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt == null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  return startedAt == null ? null : Math.max(0, now - startedAt);
}
