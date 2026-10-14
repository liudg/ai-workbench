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
        className: "h-2 w-2 bg-sky-400 animate-pulse",
      };
    case "needs-input":
      return {
        tone: "waiting",
        word: "等待",
        prominent: true,
        className: "h-2.5 w-2.5 bg-amber-400 animate-pulse ring-2 ring-amber-400/60",
      };
    case "completed":
      return {
        tone: "ready",
        word: "就绪",
        prominent: false,
        className: "h-2 w-2 bg-emerald-400",
      };
    case "failed":
      return {
        tone: "failed",
        word: "失败",
        prominent: false,
        className: "h-2 w-2 bg-red-400",
      };
    case "stopped":
      return {
        tone: "stopped",
        word: "已停止",
        prominent: false,
        className: "h-2 w-2 bg-zinc-500",
      };
    default:
      return null;
  }
}

/** 正在跑，或在等用户输入 / 批准。这些排在项目组前面。 */
export function isPinnedSession(status: string | null | undefined): boolean {
  return status === "running" || status === "needs-input";
}
