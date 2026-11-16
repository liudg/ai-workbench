import { cn } from "@/lib/utils";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import type { SlashCommand } from "@/types";
import { SuggestionList } from "./SuggestionList";

export function SlashMenu({
  matches,
  selected,
  planOn,
  onPick,
}: {
  matches: SlashCommand[];
  selected: number;
  planOn: boolean;
  onPick: (command: SlashCommand) => void;
}) {
  return (
    <SuggestionList label="斜杠命令" active={selected}>
      {matches.length === 0 && (
        <p className="px-2.5 py-2 text-xs text-wb-fg-3">没有匹配的命令</p>
      )}
      {matches.map((command, index) => (
        <button
          key={command.name}
          type="button"
          role="option"
          aria-selected={index === selected}
          className={cn(
            "flex w-full min-w-0 items-baseline gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
            index === selected ? "wb-menu-active" : "hover:bg-wb-hover",
          )}
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onPick(command);
          }}
        >
          <span className="shrink-0 font-mono text-[13px] font-medium text-wb-fg">
            {command.name}
          </span>
          <span className="min-w-0 truncate text-xs text-wb-fg-3">
            {command.name === "/plan" ? (planOn ? DESKTOP_ZH.planOff : DESKTOP_ZH.planOn) : command.hint}
          </span>
        </button>
      ))}
    </SuggestionList>
  );
}
