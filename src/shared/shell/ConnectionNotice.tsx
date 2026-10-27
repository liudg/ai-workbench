import { useConnectionStatus } from "@/lib/daemon";

/** 连不上后台服务时显示在侧栏底部；连上后不占位置。 */
export function ConnectionNotice() {
  const status = useConnectionStatus();
  if (status === "online" || status === "disabled") return null;
  return (
    <div className="mx-3 mb-3 flex items-center gap-2 rounded-lg border border-[#2a2a2a] bg-[#1a1a1a] px-3 py-2 text-xs text-[#bdbdbd]">
      <span
        className={status === "connecting" ? "h-1.5 w-1.5 animate-pulse rounded-full bg-[#4f8dff]" : "h-1.5 w-1.5 rounded-full bg-[#d97706]"}
      />
      {status === "connecting" ? "正在连接后台服务" : "没有连上后台服务，正在重试"}
    </div>
  );
}
