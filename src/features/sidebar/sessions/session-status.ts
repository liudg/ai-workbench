export type SessionDotTone = "running" | "waiting" | "ready" | "failed" | "stopped";

export interface SessionStatusView {
  tone: SessionDotTone;
  word: string;
  prominent: boolean;
  className: string;
}

/** 会话状态点。适配器没给状态时返回 null，调用方不画占位。 */
export function sessionStatusView(status: string | null | undefined): SessionStatusView | null {
  switch (status) {
    case "running":
      return {
        tone: "running",
        word: "运行中",
        prominent: false,
        className: "h-1.5 w-1.5 bg-[#4f8dff]",
      };
    case "needs-input":
      return {
        tone: "waiting",
        word: "等待",
        prominent: true,
        className: "h-1.5 w-1.5 bg-amber-400",
      };
    case "failed":
      return {
        tone: "failed",
        word: "失败",
        prominent: false,
        className: "h-1.5 w-1.5 bg-red-400",
      };
    case "completed":
    case "stopped":
      return null;
    default:
      return null;
  }
}

/** 正在跑，或在等用户输入 / 批准。这些排在项目组前面。 */
export function isPinnedSession(status: string | null | undefined): boolean {
  return status === "running" || status === "needs-input";
}
