import { useCallback, useRef, useState } from "react";
import { Check, ChevronDown, Folder, MessageSquare } from "lucide-react";

import { cn } from "@/lib/utils";
import { useComposerMenu } from "./useComposerMenu";

const CARD_SHADOW = "0 1px 2px rgba(0,0,0,.4), inset 0 1px 0 rgba(255,255,255,.04)";
const CARD_BG = "linear-gradient(180deg, #1c1c1f 0%, #17171a 100%)";
const CARD_BG_HOT = "linear-gradient(180deg, #242428 0%, #1e1e22 100%)";

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
        className="inline-flex max-w-full items-center gap-1.5 rounded-[10px] border py-1 pl-1 pr-2.5 text-[13px] leading-5 text-[#ececef]"
        style={{
          backgroundImage: lifted ? CARD_BG_HOT : CARD_BG,
          borderColor: lifted ? "#3a3a42" : "#2e2e33",
          boxShadow: CARD_SHADOW,
        }}
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
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px] bg-[#26262b] text-[#d2d2d6]">
          {chat ? (
            <MessageSquare className="h-3 w-3" strokeWidth={1.75} />
          ) : (
            <Folder className="h-3 w-3" strokeWidth={1.75} />
          )}
        </span>
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[#9a9aa0]" strokeWidth={1.5} />
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="选择项目"
          data-work-context-menu=""
          className="fixed z-50 min-w-[220px] overflow-hidden rounded-[10px] border border-[#2e2e33] py-1"
          style={{ top: -9999, left: 8, backgroundImage: CARD_BG, boxShadow: CARD_SHADOW }}
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
