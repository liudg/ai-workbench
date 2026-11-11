export type SessionDotTone = "running" | "waiting" | "ready" | "failed" | "stopped";

export interface SessionStatusView {
  tone: SessionDotTone;
  word: string;
  prominent: boolean;
  /** 运行中是转圈；等待是环里的点；失败是实心点。 */
  marker: "spinner" | "ring" | "dot";
  ringClass: string;
  dotClass: string;
}

/** 会话状态点。适配器没给状态时返回 null，调用方不画占位。 */
export function sessionStatusView(status: string | null | undefined): SessionStatusView | null {
  switch (status) {
    case "running":
      return {
        tone: "running",
        word: "运行中",
        prominent: false,
        marker: "spinner",
        ringClass: "text-[var(--wb-muted)]",
        dotClass: "",
      };
    case "needs-input":
      return {
        tone: "waiting",
        word: "等待",
        prominent: true,
        marker: "ring",
        ringClass: "border-[var(--wb-warn-strong)]",
        dotClass: "bg-[var(--wb-warn-strong)]",
      };
    case "failed":
      return {
        tone: "failed",
        word: "失败",
        prominent: false,
        marker: "dot",
        ringClass: "",
        dotClass: "bg-[var(--wb-danger-strong)]",
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
