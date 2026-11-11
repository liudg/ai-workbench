import { cn } from "@/lib/utils";
import type { AgentSkillOption } from "@/types";
import { skillEmptyCopy } from "./skills";

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
    <div
      role="listbox"
      aria-label="技能"
      data-skill-menu
      className="absolute bottom-full left-1/2 z-20 mb-2 max-h-40 w-[min(32rem,100%)] -translate-x-1/2 overflow-x-hidden overflow-y-auto rounded-xl border border-[var(--wb-border-strong)] bg-[var(--wb-elev)] py-1 shadow-[var(--wb-float-shadow)]"
    >
      {matches.length === 0 ? (
        <p className="px-3 py-2 text-xs text-[var(--wb-muted)]" data-skill-empty={emptyKind}>
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
              "grid w-full grid-cols-[max-content_minmax(0,1fr)] items-center gap-3 px-3 py-1.5 text-left transition-colors hover:bg-[var(--wb-hover)]",
              skill === active && "bg-[var(--wb-hover-strong)]",
            )}
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onPick(skill);
            }}
          >
            <span
              data-skill-mention={skill.mention}
              className="min-w-max whitespace-nowrap font-mono text-sm text-[var(--wb-text-strong)]"
            >{`$${skill.mention}`}</span>
            <span className="min-w-0 truncate text-xs leading-4 text-[var(--wb-muted)]">
              {skill.label}
              {skill.description ? ` · ${skill.description}` : ""}
            </span>
          </button>
        ))
      )}
    </div>
  );
}
