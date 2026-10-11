import { cn } from "@/lib/utils";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import type { SlashCommand } from "@/types";

export function SlashMenu({
  matches,
  selected,
  token,
  planOn,
  onPick,
}: {
  matches: SlashCommand[];
  selected: number;
  token: string | null;
  planOn: boolean;
  onPick: (command: SlashCommand) => void;
}) {
  return (
    <div
      role="listbox"
      aria-label="斜杠命令"
      className="absolute bottom-full left-0 right-0 z-20 mb-2 overflow-hidden rounded-xl border border-zinc-700/80 bg-zinc-900 py-1 shadow-xl shadow-black/50"
    >
      {matches.length === 0 && (
        <p className="px-3 py-2 text-xs text-zinc-500">这条斜杠命令不会发给模型。回车后会在时间线里说明。</p>
      )}
      {matches.map((command, index) => (
        <button
          key={command.name}
          type="button"
          role="option"
          aria-selected={index === selected}
          className={cn(
            "flex w-full min-w-0 items-baseline gap-3 px-3 py-2 text-left hover:bg-zinc-800",
            index === selected && "bg-zinc-800",
          )}
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onPick(command);
          }}
        >
          <span className="shrink-0 text-sm text-zinc-100">
            {command.name === "/review"
              ? DESKTOP_ZH.reviewTitle
              : command.name === "/plan"
                ? DESKTOP_ZH.planTitle
                : command.name}
          </span>
          <span className="min-w-0 truncate text-xs text-zinc-500">
            {command.name === "/plan" ? (planOn ? DESKTOP_ZH.planOff : DESKTOP_ZH.planOn) : command.hint}
          </span>
        </button>
      ))}
      {token === "/" && (
        <p className="border-t border-zinc-800 px-3 py-2 text-[11px] leading-4 text-zinc-600">
          /vim、/theme 等终端命令可以输入，但不会发给模型。
        </p>
      )}
    </div>
  );
}
