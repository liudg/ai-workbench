import { useConnectionStatus } from "@/lib/daemon";

/** 连不上后台服务时显示在侧栏底部；连上后不占位置。 */
export function ConnectionNotice() {
  const status = useConnectionStatus();
  if (status === "online" || status === "disabled") return null;
  return (
    <div className="mx-2.5 mb-2 flex items-center gap-2 rounded-lg border border-wb-border bg-wb-elev px-2.5 py-2 text-xs text-wb-fg-2">
      <span
        className={status === "connecting" ? "h-1.5 w-1.5 animate-pulse rounded-full bg-wb-accent" : "h-1.5 w-1.5 rounded-full bg-wb-warn"}
      />
      {status === "connecting" ? "正在连接服务…" : "服务连接中断，正在重连"}
    </div>
  );
}
