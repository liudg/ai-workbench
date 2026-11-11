import { useCallback, useRef, useState } from "react";
import { Check, ChevronDown, Folder, MessageSquare } from "lucide-react";

import { cn } from "@/lib/utils";
import { CONTEXT_PILL_BASE_CLASS, contextPillStyle } from "./context-pill";
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
  const [hot, setHot] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useComposerMenu(open, anchorRef, menuRef, close);
  const chat = selectedId === standaloneId;
  const lifted = open || hot;

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={cn(CONTEXT_PILL_BASE_CLASS, "max-w-full pl-1 pr-2.5")}
        style={contextPillStyle(lifted)}
        aria-label={chat ? "聊天" : `项目：${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        data-work-context={chat ? "chat" : selectedId}
        data-work-context-icon={chat ? "chat" : "folder"}
        onMouseEnter={() => setHot(true)}
        onMouseLeave={() => setHot(false)}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px] bg-[var(--wb-chip)] text-[var(--wb-muted)]">
          {chat ? (
            <MessageSquare className="h-3 w-3" strokeWidth={1.75} />
          ) : (
            <Folder className="h-3 w-3" strokeWidth={1.75} />
          )}
        </span>
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--wb-faint)]" strokeWidth={1.5} />
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="选择项目"
          data-work-context-menu=""
          className="fixed z-50 min-w-[220px] overflow-hidden rounded-xl border border-[var(--wb-border-strong)] bg-[var(--wb-elev)] py-1 shadow-[var(--wb-float-shadow)]"
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
                  "flex w-full items-center justify-between px-3 py-2 text-left text-sm text-[var(--wb-text-strong)] hover:bg-[var(--wb-hover)]",
                  selected && "bg-[var(--wb-hover)]",
                  !canRetarget && !selected && "cursor-default text-[var(--wb-muted)] hover:bg-transparent",
                )}
                onClick={(event) => {
                  event.stopPropagation();
                  close();
                  if (!canRetarget || selected) return;
                  onPickProject(project.id);
                }}
              >
                <span className="truncate">{project.name}</span>
                {selected ? <Check className="h-4 w-4 shrink-0 text-[var(--wb-text-strong)]" strokeWidth={2} /> : null}
              </button>
            );
          })}
          <div className={cn(projects.length > 0 && "mt-1 border-t border-[var(--wb-border)]")} />
          <button
            type="button"
            role="menuitemradio"
            aria-checked={selectedId === standaloneId}
            data-work-context-standalone=""
            disabled={!canRetarget && selectedId !== standaloneId}
            className={cn(
              "flex w-full items-center justify-between px-3 py-2 text-left text-sm text-[var(--wb-text-strong)] hover:bg-[var(--wb-hover)]",
              selectedId === standaloneId && "bg-[var(--wb-hover)]",
              !canRetarget && selectedId !== standaloneId && "cursor-default text-[var(--wb-muted)] hover:bg-transparent",
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
              <Check className="h-4 w-4 shrink-0 text-[var(--wb-text-strong)]" strokeWidth={2} />
            ) : null}
          </button>
        </div>
      )}
    </>
  );
}
