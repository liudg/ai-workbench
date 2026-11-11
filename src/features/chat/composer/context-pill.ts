import type { CSSProperties } from "react";

export const CONTEXT_PILL_BASE_CLASS =
  "inline-flex items-center gap-1.5 rounded-[10px] border py-1 text-[13px] leading-5 text-[var(--wb-text-strong)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--wb-accent)]/35";

export function contextPillStyle(lifted: boolean): CSSProperties {
  return {
    backgroundImage: lifted ? "var(--wb-context-pill-hot)" : "var(--wb-context-pill-bg)",
    borderColor: lifted ? "var(--wb-border-strong)" : "var(--wb-border)",
    boxShadow: "var(--wb-context-pill-shadow)",
  };
}
