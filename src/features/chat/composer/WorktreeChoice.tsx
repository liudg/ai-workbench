import { cn } from "@/lib/utils";
import { CARD_BG, CARD_BG_HOT, CARD_SHADOW } from "./context-card";

export function WorktreeToggle({
  pressed,
  onToggle,
}: {
  pressed: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      data-worktree-toggle=""
      aria-pressed={pressed}
      className="inline-flex max-w-full items-center gap-1.5 rounded-[10px] border py-1 pl-2 pr-2.5 text-[13px] leading-5 text-[#ececef]"
      style={{
        backgroundImage: pressed ? CARD_BG_HOT : CARD_BG,
        borderColor: pressed ? "#3a3a42" : "#2e2e33",
        boxShadow: CARD_SHADOW,
      }}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      <span
        aria-hidden
        className={cn("h-2 w-2 shrink-0 rounded-full", pressed ? "bg-[#ececef]" : "bg-[#5c5c66]")}
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
      className="inline-flex max-w-[18rem] min-w-0 items-center truncate rounded-[10px] border border-[#2e2e33] px-2.5 py-1 text-[13px] leading-5 text-[#ececef]"
      style={{ backgroundImage: CARD_BG, boxShadow: CARD_SHADOW }}
    >
      {label}
    </span>
  );
}
