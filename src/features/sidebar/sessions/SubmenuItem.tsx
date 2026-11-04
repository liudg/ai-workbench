import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";
import { submenuPosition } from "../fixed-menu-position";
import type { SessionMenuAction, SessionMenuItem } from "./session-menu";
import type { AgentKind } from "@/types";

/** 鼠标移开后留一会儿，斜着移到二级菜单的路上不至于关掉。 */
const CLOSE_DELAY_MS = 150;

/** 会话菜单里带二级菜单的一项：悬停或点开向侧边展开，方向键也能进出。 */
export function SubmenuItem({
  item,
  onSelect,
}: {
  item: SessionMenuItem;
  onSelect: (action: SessionMenuAction, agent?: AgentKind) => void;
}) {
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | undefined>(undefined);

  const cancelClose = () => window.clearTimeout(closeTimer.current);
  const show = () => {
    cancelClose();
    setOpen(true);
  };
  const hideSoon = () => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  };
  useEffect(() => cancelClose, []);

  useLayoutEffect(() => {
    if (!open) {
      setBox(null);
      return;
    }
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger || !panel) return;
    setBox(
      submenuPosition({
        item: trigger.getBoundingClientRect(),
        menu: { width: panel.offsetWidth, height: panel.offsetHeight },
        viewport: { width: window.innerWidth, height: window.innerHeight },
      }),
    );
  }, [open]);

  const focusFirst = () =>
    requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus());

  return (
    <div onMouseEnter={show} onMouseLeave={hideSoon}>
      <button
        ref={triggerRef}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        data-session-action={item.id}
        className={cn(
          "flex w-full items-center justify-between px-3 py-2 text-left text-sm text-zinc-100 hover:bg-zinc-800",
          open && "bg-zinc-800",
        )}
        onClick={(event) => {
          event.stopPropagation();
          show();
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight" || event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            show();
            focusFirst();
          }
        }}
      >
        {item.label}
        <ChevronRight className="h-3.5 w-3.5 text-zinc-500" aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={panelRef}
          role="menu"
          aria-label={item.label}
          className="fixed z-50 min-w-40 rounded-xl border border-zinc-700/80 bg-zinc-900 py-1 shadow-xl shadow-black/50"
          style={box ? { top: box.top, left: box.left } : { top: 0, left: 0, visibility: "hidden" }}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft") return;
            event.preventDefault();
            setOpen(false);
            triggerRef.current?.focus();
          }}
        >
          {item.children?.map((child) => (
            <button
              key={child.key}
              type="button"
              role="menuitem"
              data-session-action={child.id}
              data-agent={child.agent}
              className="block w-full whitespace-nowrap px-3 py-2 text-left text-sm text-zinc-100 hover:bg-zinc-800 focus:bg-zinc-800 focus:outline-none"
              onClick={(event) => {
                event.stopPropagation();
                onSelect(child.id, child.agent);
              }}
            >
              {child.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
