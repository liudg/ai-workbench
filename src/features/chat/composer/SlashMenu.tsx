import { cn } from "@/lib/utils";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import type { SlashCommand } from "@/types";
import { SuggestionList } from "./SuggestionList";

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
    <SuggestionList
      label="斜杠命令"
      active={selected}
      footer={
        token === "/" ? (
          <p className="border-t border-wb-border px-3 py-2 text-[11px] leading-4 text-wb-fg-3">
            /vim、/theme 等终端专属命令无需在此发送。
          </p>
        ) : null
      }
    >
      {matches.length === 0 && (
        <p className="px-3 py-2 text-xs text-wb-fg-3">此命令仅适用于终端界面，回车后将在对话中说明。</p>
      )}
      {matches.map((command, index) => (
        <button
          key={command.name}
          type="button"
          role="option"
          aria-selected={index === selected}
          className={cn(
            "flex w-full min-w-0 items-baseline gap-3 px-3 py-2 text-left transition-colors hover:bg-wb-hover",
            index === selected && "bg-wb-active",
          )}
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onPick(command);
          }}
        >
          <span className="shrink-0 text-sm text-wb-fg">
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
