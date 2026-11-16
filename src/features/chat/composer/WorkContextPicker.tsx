import { useCallback, useRef, useState } from "react";
import { Check, ChevronDown, Folder, MessageSquare } from "lucide-react";

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
  const chat = selectedId === standaloneId;

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={cn(
          "inline-flex h-6 max-w-full items-center gap-1.5 rounded-md border px-2 text-xs transition-colors",
          open
            ? "border-wb-border-strong bg-wb-active text-wb-fg"
            : "border-wb-border bg-wb-surface/75 text-wb-fg-2 hover:border-wb-border-strong hover:bg-wb-hover hover:text-wb-fg",
        )}
        aria-label={chat ? "聊天" : `项目：${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        data-work-context={chat ? "chat" : selectedId}
        data-work-context-icon={chat ? "chat" : "folder"}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        {chat ? (
          <MessageSquare className="h-3 w-3 shrink-0 opacity-80" strokeWidth={1.75} />
        ) : (
          <Folder className="h-3 w-3 shrink-0 opacity-80" strokeWidth={1.75} />
        )}
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDown className="h-3 w-3 shrink-0 opacity-70" strokeWidth={1.5} />
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="选择项目"
          data-work-context-menu=""
          className="wb-popover fixed z-50 min-w-[220px] space-y-0.5 overflow-hidden rounded-xl p-1.5"
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
                  "flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] leading-5 text-wb-fg transition-colors",
                  selected
                    ? "wb-menu-active font-medium"
                    : !canRetarget
                      ? "cursor-default text-wb-dim"
                      : "hover:bg-wb-hover",
                )}
                onClick={(event) => {
                  event.stopPropagation();
                  close();
                  if (!canRetarget || selected) return;
                  onPickProject(project.id);
                }}
              >
                <span className="truncate">{project.name}</span>
                {selected ? <Check className="h-3.5 w-3.5 shrink-0 text-wb-accent-ink" strokeWidth={2} /> : null}
              </button>
            );
          })}
          {projects.length > 0 ? <div className="my-1 border-t border-wb-border" /> : null}
          <button
            type="button"
            role="menuitemradio"
            aria-checked={selectedId === standaloneId}
            data-work-context-standalone=""
            disabled={!canRetarget && selectedId !== standaloneId}
            className={cn(
              "flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] leading-5 text-wb-fg transition-colors",
              selectedId === standaloneId
                ? "wb-menu-active font-medium"
                : !canRetarget
                  ? "cursor-default text-wb-dim"
                  : "hover:bg-wb-hover",
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
              <Check className="h-3.5 w-3.5 shrink-0 text-wb-accent-ink" strokeWidth={2} />
            ) : null}
          </button>
        </div>
      )}
    </>
  );
}
