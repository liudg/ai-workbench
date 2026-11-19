import type { SessionEvent } from "../../../types/index.ts";
import { DESKTOP_ZH } from "../../../shared/strings/desktop-zh.ts";
import { activityStepTitle, isViewedImages, isWebSearch, titleFromName, type ToolCallEvent } from "./activity-fold.ts";
import { backgroundFailureText, type BackgroundTaskEvent } from "./background-task-display.ts";

export type ToolState = "running" | "done" | "failed" | "stopped";

/**
 * 一条工具调用怎么画。关联了后台任务时以它的状态为准（跨回合仍在跑继续转圈；
 * 主动停掉记为 `stopped`，不因底层退出码 -1 误报失败）。
 * 普通工具调用只在这一轮还在跑时转圈；一轮结束后还留着的按已结束画。照 orca `NativeChatToolRun.tsx`。
 */
export function toolState(
  event: ToolCallEvent,
  live: boolean,
  background?: BackgroundTaskEvent,
): ToolState {
  if (background) {
    if (background.status === "running") return "running";
    if (background.status === "stopped") return "stopped";
    if (background.status === "failed") return "failed";
    return "done";
  }
  if (event.status === "failed") return "failed";
  if (event.status === "running" && live) return "running";
  return "done";
}

/** 失败的说明：优先后台任务的退出码，其次工具自己的退出码，都没有就写「失败」。 */
export function toolFailureText(event: ToolCallEvent, background?: BackgroundTaskEvent): string {
  return backgroundFailureText(background?.exit_code ?? event.exit_code);
}

const QUIET_KINDS: ReadonlySet<SessionEvent["kind"]> = new Set([
  "status-changed",
  "context-usage",
  "session-usage",
  "turn-anchor",
  "collaboration-mode",
  "goal",
  "turn-diff",
  "file-change",
  "turn-changes",
]);

/**
 * 进行中的一轮此刻在做什么，给活动流末行用。
 * 最后一条是思考就是「正在思考」；否则有还在跑的工具，取最近开始的那条；
 * 再否则看最后一条正文；都不是就是「正在处理」。只看事件，不看 Agent 名字。
 */
export function liveActivityLabel(events: readonly SessionEvent[]): string {
  let last: SessionEvent | null = null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (!QUIET_KINDS.has(events[index].kind)) {
      last = events[index];
      break;
    }
  }
  if (last?.kind === "thinking") return DESKTOP_ZH.liveThinking;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind === "tool-call" && event.status === "running") return runningToolLabel(event);
  }
  if (last?.kind === "agent-message" && last.phase !== "commentary") return DESKTOP_ZH.liveReplying;
  return DESKTOP_ZH.liveWorking;
}

function runningToolLabel(event: ToolCallEvent): string {
  if (isWebSearch(event)) return DESKTOP_ZH.liveSearchingWeb;
  if (isViewedImages(event)) return DESKTOP_ZH.liveViewingImages;
  if (event.name === "image_generation") return DESKTOP_ZH.liveGeneratingImage;
  if (event.name === "command") {
    return DESKTOP_ZH.liveRunning.replace("{title}", activityStepTitle(event.name, event.summary));
  }
  return DESKTOP_ZH.liveCalling.replace("{title}", titleFromName(event.name));
}
