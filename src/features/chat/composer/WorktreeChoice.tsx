import { cn } from "@/lib/utils";
import { CARD_BG, CARD_SHADOW } from "./context-card";

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
        background: pressed ? "#19365b" : CARD_BG,
        borderColor: pressed ? "#5b9cf5" : "#2e2e33",
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

export function WorktreeShelvedLabel({
  title,
  restoring,
  onRestore,
}: {
  title: string;
  restoring: boolean;
  onRestore: () => void;
}) {
  return (
    <span
      data-worktree-shelved=""
      title={title}
      className="inline-flex max-w-full min-w-0 items-center gap-2 rounded-[10px] border border-[#2e2e33] py-1 pl-2.5 pr-1 text-[13px] leading-5 text-[#a1a1aa]"
      style={{ backgroundImage: CARD_BG, boxShadow: CARD_SHADOW }}
    >
      <span className="truncate">工作树已清理，发消息时自动恢复</span>
      <button
        type="button"
        data-worktree-restore=""
        disabled={restoring}
        className="shrink-0 rounded-md px-2 text-[#ececef] hover:bg-white/[0.08] disabled:opacity-60"
        onClick={(event) => {
          event.stopPropagation();
          onRestore();
        }}
      >
        {restoring ? "正在恢复…" : "恢复"}
      </button>
    </span>
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
