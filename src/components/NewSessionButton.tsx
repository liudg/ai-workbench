import { useEffect, useRef, useState, type RefObject } from "react";
import { Plus, SquarePen } from "lucide-react";

import { cn } from "@/lib/utils";
import { useWorkbench } from "@/store";
import { AGENT_LABELS, AGENT_OPTIONS, type AgentKind } from "@/types";
import { buttonVariants } from "./ui/button";

function placeFixedMenu(
  anchor: HTMLElement,
  menu: HTMLElement,
  prefer: "below" | "above",
) {
  const rect = anchor.getBoundingClientRect();
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  let left = prefer === "below" ? rect.right - width : rect.left;
  left = Math.min(Math.max(8, left), window.innerWidth - width - 8);
  let top = prefer === "above" ? rect.top - height - 6 : rect.bottom + 6;
  if (top + height > window.innerHeight - 8) top = rect.top - height - 6;
  if (top < 8) top = rect.bottom + 6;
  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;
}

function useFixedMenu(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  menuRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  prefer: "below" | "above" = "below",
) {
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = anchorRef.current;
      const menu = menuRef.current;
      if (anchor && menu) placeFixedMenu(anchor, menu, prefer);
    };
    place();
    const frame = requestAnimationFrame(place);
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (anchorRef.current?.contains(target) || menuRef.current?.contains(target)) {
        return;
      }
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, anchorRef, menuRef, onClose, prefer]);
}

export function NewSessionButton({
  projectId,
  appearance = "pencil",
  className,
  title = "新建会话",
}: {
  projectId: string;
  appearance?: "pencil" | "plus" | "primary";
  className?: string;
  title?: string;
}) {
  const createSession = useWorkbench((s) => s.createSession);
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = () => setOpen(false);
  useFixedMenu(open, anchorRef, menuRef, close, "below");

  const choose = (agent: AgentKind) => {
    setOpen(false);
    void createSession(projectId, agent);
  };

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={cn(
          appearance === "primary" && buttonVariants({ variant: "default" }),
          className,
        )}
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={open}
        title={title}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        {appearance === "primary" ? (
          <>
            <Plus /> 新建会话
          </>
        ) : appearance === "plus" ? (
          <Plus className="h-4 w-4" />
        ) : (
          <SquarePen className="h-3.5 w-3.5" />
        )}
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="选择 Agent"
          className="fixed z-50 w-52 overflow-hidden rounded-xl border border-zinc-700/80 bg-zinc-900 py-1 shadow-xl shadow-black/50"
          style={{ top: -9999, left: 8 }}
        >
          <div className="px-3 pb-1 pt-1.5 text-[11px] text-zinc-500">
            选择 Agent
          </div>
          {AGENT_OPTIONS.map((agent) => (
            <button
              key={agent}
              type="button"
              role="menuitem"
              className="block w-full px-3 py-2 text-left text-sm text-zinc-100 hover:bg-zinc-800"
              onClick={(event) => {
                event.stopPropagation();
                choose(agent);
              }}
            >
              {AGENT_LABELS[agent]}
            </button>
          ))}
          <div className="mx-2 my-1 border-t border-zinc-800" />
          <div className="px-3 py-2 text-xs text-zinc-600">更多模型即将支持</div>
        </div>
      )}
    </>
  );
}
