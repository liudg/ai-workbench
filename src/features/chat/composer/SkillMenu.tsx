import { cn } from "@/lib/utils";
import type { AgentSkillOption } from "@/types";
import { skillEmptyCopy } from "./skills";
import { SuggestionList } from "./SuggestionList";

export function SkillMenu({
  matches,
  active,
  hasCatalog,
  skillsError,
  listedCount,
  onPick,
}: {
  matches: AgentSkillOption[];
  active: AgentSkillOption | undefined;
  hasCatalog: boolean;
  skillsError?: string | null;
  listedCount: number;
  onPick: (skill: AgentSkillOption) => void;
}) {
  const empty = skillEmptyCopy({ hasCatalog, skillsError, listed: listedCount });
  const emptyKind = !hasCatalog ? "loading" : skillsError && listedCount === 0 ? "error" : listedCount === 0 ? "none" : "no-match";
  return (
    <SuggestionList label="技能" active={active ? matches.indexOf(active) : -1} data-skill-menu>
      {matches.length === 0 ? (
        <p className="px-3 py-2 text-xs text-zinc-500" data-skill-empty={emptyKind}>
          {empty}
        </p>
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
            <span
              data-skill-mention={skill.mention}
              className="max-w-[60%] shrink-0 truncate text-sm text-zinc-100"
            >{`$${skill.mention}`}</span>
            <span className="min-w-0 truncate text-xs leading-4 text-zinc-500">
              {skill.label}
              {skill.description ? ` · ${skill.description}` : ""}
            </span>
          </button>
        ))
      )}
    </SuggestionList>
  );
}
