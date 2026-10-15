import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";

/** 进行中的思考只占活动流最后一行。字面有一道扫光；结束后整行不留。 */
export function ThinkingStatus() {
  return (
    <div className="event-in min-w-0 px-6 py-1" data-thinking-status>
      <p className="min-w-0 pl-6 text-[13px]">
        <span className="thinking-shimmer">{DESKTOP_ZH.activityThinkingNow}</span>
      </p>
    </div>
  );
}
