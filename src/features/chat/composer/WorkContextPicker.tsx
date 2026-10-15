import { useCallback, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";
import { useComposerMenu } from "./useComposerMenu";

export function WorkContextPicker({
  projects,
  canRetarget,
  onPickProject,
}: {
  projects: { id: string; name: string }[];
  canRetarget: boolean;
  onPickProject: (projectId: string) => void;
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
        className="mb-1 flex items-center gap-1 rounded-md py-0.5 text-[13px] text-[#d0d0d0] hover:text-white"
        aria-label="聊天"
        aria-haspopup="menu"
        aria-expanded={open}
        data-work-context="chat"
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        聊天
        <ChevronDown className="h-3.5 w-3.5 text-[#8d8d8d]" strokeWidth={2} />
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
          {projects.map((project) => (
            <button
              key={project.id}
              type="button"
              role="menuitem"
              data-work-context-project={project.id}
              disabled={!canRetarget}
              className={cn(
                "block w-full px-3 py-2 text-left text-sm text-zinc-100 hover:bg-white/[0.06]",
                !canRetarget && "cursor-default text-zinc-400 hover:bg-transparent",
              )}
              onClick={(event) => {
                event.stopPropagation();
                if (!canRetarget) return;
                close();
                onPickProject(project.id);
              }}
            >
              {project.name}
            </button>
          ))}
          <div className={cn(projects.length > 0 && "mt-1 border-t border-zinc-800")} />
          <button
            type="button"
            role="menuitemradio"
            aria-checked="true"
            data-work-context-standalone=""
            className="flex w-full items-center justify-between bg-white/[0.04] px-3 py-2 text-left text-sm text-zinc-100"
            onClick={(event) => {
              event.stopPropagation();
              close();
            }}
          >
            不在项目中工作
            <Check className="h-4 w-4 text-zinc-200" strokeWidth={2} />
          </button>
        </div>
      )}
    </>
  );
}
