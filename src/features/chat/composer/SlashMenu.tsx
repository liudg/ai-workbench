import { cn } from "@/lib/utils";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import type { SlashCommand } from "@/types";

export function SlashMenu({
  matches,
  selected,
  planOn,
  onPick,
}: {
  matches: SlashCommand[];
  selected: number;
  token?: string | null;
  planOn: boolean;
  onPick: (command: SlashCommand) => void;
}) {
  return (
    <div
      role="listbox"
      aria-label="斜杠命令"
      className="absolute bottom-full left-0 right-0 z-20 mb-2 overflow-hidden rounded-xl border border-[var(--wb-border-strong)] bg-[var(--wb-elev)] py-1 shadow-[var(--wb-float-shadow)]"
    >
      {matches.length === 0 && (
        <p className="px-3 py-2 text-xs text-[var(--wb-muted)]">没有匹配的命令，按回车执行。</p>
      )}
      {matches.map((command, index) => (
        <button
          key={command.name}
          type="button"
          role="option"
          aria-selected={index === selected}
          className={cn(
            "flex w-full min-w-0 items-baseline gap-3 px-3 py-2 text-left transition-colors hover:bg-[var(--wb-hover)]",
            index === selected && "bg-[var(--wb-hover-strong)]",
          )}
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onPick(command);
          }}
        >
          <span className="shrink-0 font-mono text-sm text-[var(--wb-text-strong)]">
            {command.name}
          </span>
          <span className="min-w-0 truncate text-xs text-[var(--wb-muted)]">
            {command.name === "/plan" ? (planOn ? DESKTOP_ZH.planOff : DESKTOP_ZH.planOn) : command.hint}
          </span>
        </button>
      ))}
    </div>
  );
}
