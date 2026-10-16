import { useCallback, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";
import { useComposerMenu } from "./useComposerMenu";

export function WorkContextPicker({
  label,
  projects,
  selectedId,
  standaloneId,
  canRetarget,
  onPickProject,
  onPickStandalone,
}: {
  label: string;
  projects: { id: string; name: string }[];
  selectedId: string;
  standaloneId: string;
  canRetarget: boolean;
  onPickProject: (projectId: string) => void;
  onPickStandalone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useComposerMenu(open, anchorRef, menuRef, close);

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="flex max-w-full items-center gap-1 rounded-md py-0.5 text-[13px] text-[#d0d0d0] hover:text-white"
        aria-label={label === "聊天" ? "聊天" : `项目：${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        data-work-context={selectedId === standaloneId ? "chat" : selectedId}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        <span className="truncate">{label}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[#8d8d8d]" strokeWidth={2} />
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="选择项目"
          data-work-context-menu=""
          className="fixed z-50 min-w-[220px] overflow-hidden rounded-xl border border-zinc-700/80 bg-[#1c1c1c] py-1 shadow-xl shadow-black/50"
          style={{ top: -9999, left: 8 }}
        >
          {projects.map((project) => {
            const selected = project.id === selectedId;
            return (
              <button
                key={project.id}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                data-work-context-project={project.id}
                disabled={!canRetarget && !selected}
                className={cn(
                  "flex w-full items-center justify-between px-3 py-2 text-left text-sm text-zinc-100 hover:bg-white/[0.06]",
                  selected && "bg-white/[0.04]",
                  !canRetarget && !selected && "cursor-default text-zinc-400 hover:bg-transparent",
                )}
                onClick={(event) => {
                  event.stopPropagation();
                  close();
                  if (!canRetarget || selected) return;
                  onPickProject(project.id);
                }}
              >
                <span className="truncate">{project.name}</span>
                {selected ? <Check className="h-4 w-4 shrink-0 text-zinc-200" strokeWidth={2} /> : null}
              </button>
            );
          })}
          <div className={cn(projects.length > 0 && "mt-1 border-t border-zinc-800")} />
          <button
            type="button"
            role="menuitemradio"
            aria-checked={selectedId === standaloneId}
            data-work-context-standalone=""
            disabled={!canRetarget && selectedId !== standaloneId}
            className={cn(
              "flex w-full items-center justify-between px-3 py-2 text-left text-sm text-zinc-100 hover:bg-white/[0.06]",
              selectedId === standaloneId && "bg-white/[0.04]",
              !canRetarget && selectedId !== standaloneId && "cursor-default text-zinc-400 hover:bg-transparent",
            )}
            onClick={(event) => {
              event.stopPropagation();
              close();
              if (!canRetarget || selectedId === standaloneId) return;
              onPickStandalone();
            }}
          >
            不在项目中工作
            {selectedId === standaloneId ? (
              <Check className="h-4 w-4 shrink-0 text-zinc-200" strokeWidth={2} />
            ) : null}
          </button>
        </div>
      )}
    </>
  );
}
