import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import { Plus, SquarePen } from "lucide-react";

import { installedAgents } from "@/lib/agents";
import { cn } from "@/lib/utils";
import { useWorkbench } from "@/store";
import type { AgentKind } from "@/types";
import { buttonVariants } from "@/components/ui/button";

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
  appearance?: "pencil" | "primary";
  className?: string;
  title?: string;
}) {
  const createSession = useWorkbench((s) => s.createSession);
  const openSettings = useWorkbench((s) => s.openSettings);
  const installations = useWorkbench((s) => s.installations);
  const installed = installedAgents(installations);
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = () => setOpen(false);
  useFixedMenu(open, anchorRef, menuRef, close, "below");

  const choose = (agent: AgentKind) => {
    setOpen(false);
    void createSession(projectId, agent);
  };

  const onPress = (event: ReactMouseEvent) => {
    event.stopPropagation();
    if (installed.length === 1) {
      choose(installed[0].kind);
      return;
    }
    setOpen((value) => !value);
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
        onClick={onPress}
      >
        {appearance === "primary" ? (
          <>
            <Plus /> 新建会话
          </>
        ) : (
          <SquarePen className="h-3.5 w-3.5" />
        )}
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="选择 Agent"
          className="fixed z-50 w-60 overflow-hidden rounded-xl border border-zinc-700/80 bg-zinc-900 py-1 shadow-xl shadow-black/50"
          style={{ top: -9999, left: 8 }}
        >
          {installations === null ? (
            <div className="px-3 py-3 text-sm text-zinc-500">正在检测本地 Agent…</div>
          ) : installed.length === 0 ? (
            <div className="px-3 py-3">
              <p className="text-sm leading-5 text-zinc-300">未检测到已安装的 Agent CLI。</p>
              <button
                type="button"
                className="mt-2 text-sm text-indigo-300 hover:text-indigo-200"
                onClick={(event) => {
                  event.stopPropagation();
                  close();
                  openSettings();
                }}
              >
                打开设置
              </button>
            </div>
          ) : (
            <>
              <div className="px-3 pb-1 pt-1.5 text-[11px] text-zinc-500">选择 Agent</div>
              {installed.map((agent) => (
                <button
                  key={agent.kind}
                  type="button"
                  role="menuitem"
                  className="block w-full px-3 py-2 text-left text-sm text-zinc-100 hover:bg-zinc-800"
                  onClick={(event) => {
                    event.stopPropagation();
                    choose(agent.kind);
                  }}
                >
                  {agent.display_name}
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </>
  );
}
