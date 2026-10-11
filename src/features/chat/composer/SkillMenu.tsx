import { cn } from "@/lib/utils";
import type { AgentSkillOption } from "@/types";

export function SkillMenu({
  matches,
  active,
  hasCatalog,
  onPick,
}: {
  matches: AgentSkillOption[];
  active: AgentSkillOption | undefined;
  hasCatalog: boolean;
  onPick: (skill: AgentSkillOption) => void;
}) {
  return (
    <div
      role="listbox"
      aria-label="技能"
      className="absolute bottom-full left-0 right-0 z-20 mb-2 max-h-64 min-w-0 overflow-x-hidden overflow-y-auto rounded-xl border border-zinc-700/80 bg-zinc-900 py-1 shadow-xl shadow-black/50"
    >
      {matches.length === 0 ? (
        <p className="px-3 py-2 text-xs text-zinc-500">{hasCatalog ? "没有匹配的技能" : "正在读取技能…"}</p>
      ) : (
        matches.map((skill) => (
          <button
            key={skill.path}
            type="button"
            role="option"
            aria-selected={skill === active}
            className={cn(
              "flex w-full min-w-0 items-baseline gap-3 px-3 py-2 text-left hover:bg-zinc-800",
              skill === active && "bg-zinc-800",
            )}
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onPick(skill);
            }}
          >
            <span className="min-w-0 shrink break-all font-mono text-sm text-zinc-100">{`$${skill.mention}`}</span>
            <span className="min-w-0 truncate text-xs text-zinc-500">
              {skill.label}
              {skill.description ? ` · ${skill.description}` : ""}
            </span>
          </button>
        ))
      )}
    </div>
  );
}
