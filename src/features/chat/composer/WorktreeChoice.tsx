import { useState } from "react";

import { cn } from "@/lib/utils";
import { CONTEXT_PILL_BASE_CLASS, contextPillStyle } from "./context-pill";

export function WorktreeToggle({
  pressed,
  onToggle,
}: {
  pressed: boolean;
  onToggle: () => void;
}) {
  const [hot, setHot] = useState(false);
  return (
    <button
      type="button"
      data-worktree-toggle=""
      aria-pressed={pressed}
      className={cn(CONTEXT_PILL_BASE_CLASS, "max-w-full pl-2 pr-2.5")}
      style={contextPillStyle(pressed || hot)}
      onMouseEnter={() => setHot(true)}
      onMouseLeave={() => setHot(false)}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      <span
        aria-hidden
        className={cn(
          "h-2 w-2 shrink-0 rounded-full transition-colors",
          pressed ? "bg-[var(--wb-accent)]" : "bg-[var(--wb-faint)]",
        )}
      />
      在新的工作树中运行
    </button>
  );
}

export function WorktreeSessionLabel({ label, title }: { label: string; title: string }) {
  return (
    <span
      data-worktree-session=""
      title={title}
      className={cn(CONTEXT_PILL_BASE_CLASS, "max-w-[18rem] min-w-0 truncate px-2.5")}
      style={contextPillStyle(false)}
    >
      {label}
    </span>
  );
}
