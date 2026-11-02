// 侧边聊天顶上那行：主对话在侧边聊天开着时有了什么变化。
// 照 Codex `codex-rs/tui/src/app/side.rs` 的 `SideParentStatus`：只报开着之后的变化，
// 主对话又跑起来就清掉；在等你处理的一直报。

import type { SessionStatus } from "@/types";

export const SIDE_COPY = {
  fromMain: "来自主线程",
  closed: "侧边聊天已关闭",
  mainNeedsInput: "主线程需要你处理",
  mainFinished: "主线程已完成",
  mainFailed: "主线程失败",
  mainStopped: "主线程已中断",
} as const;

/** `changed`：侧边聊天打开之后主对话的状态变过。 */
export function mainStatusNote(status: SessionStatus, changed: boolean): string | null {
  if (status === "needs-input") return SIDE_COPY.mainNeedsInput;
  if (!changed) return null;
  switch (status) {
    case "completed":
      return SIDE_COPY.mainFinished;
    case "failed":
      return SIDE_COPY.mainFailed;
    case "stopped":
      return SIDE_COPY.mainStopped;
    default:
      return null;
  }
}
