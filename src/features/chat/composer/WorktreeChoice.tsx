import { cn } from "@/lib/utils";

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
      className={cn(
        "inline-flex h-6 max-w-full items-center gap-1.5 rounded-md border px-2 text-xs transition-colors",
        pressed
          ? "border-wb-accent/40 bg-wb-accent-soft text-wb-accent"
          : "border-wb-border bg-wb-surface/75 text-wb-fg-2 hover:border-wb-border-strong hover:bg-wb-hover hover:text-wb-fg",
      )}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      <span
        aria-hidden
        className={cn("h-1.5 w-1.5 shrink-0 rounded-full", pressed ? "bg-wb-accent" : "bg-wb-dim")}
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
      className="inline-flex h-6 max-w-full min-w-0 items-center gap-1.5 rounded-md border border-wb-border bg-wb-surface/75 pl-2 pr-1 text-xs text-wb-fg-2"
    >
      <span className="truncate">工作树已清理，发消息时自动恢复</span>
      <button
        type="button"
        data-worktree-restore=""
        disabled={restoring}
        className="shrink-0 rounded px-1.5 py-0.5 text-wb-fg transition-colors hover:bg-wb-hover disabled:opacity-60"
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
      className="inline-flex h-6 max-w-[18rem] min-w-0 items-center truncate rounded-md border border-wb-border bg-wb-surface/75 px-2 text-xs text-wb-fg-2"
    >
      {label}
    </span>
  );
}
