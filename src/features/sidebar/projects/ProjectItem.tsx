import { useCallback, useRef, useState } from "react";
import { ChevronRight, Ellipsis } from "lucide-react";

import { cn, displayPath } from "@/lib/utils";
import { aggregateStatus, type Project } from "@/types";
import { useProjectItem } from "./use-project-item";
import { useDismiss } from "../use-dismiss";
import { NewSessionButton } from "../sessions/NewSessionButton";
import { SessionList } from "../sessions/SessionList";
import { isPinnedSession } from "../sessions/session-status";
import { StatusDot } from "./StatusDot";

export function ProjectItem({ project }: { project: Project }) {
  const { sessions, selected, activeSessionId, selectProject, removeProject } = useProjectItem(project);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    setConfirming(false);
  }, []);
  useDismiss(menuOpen, menuRef, closeMenu);

  const status = sessions ? aggregateStatus(sessions) : null;
  const runningCount = sessions?.filter((s) => isPinnedSession(s.status)).length;
  const items = sessions ?? [];

  const onHeaderClick = () => {
    if (selected) {
      setCollapsed((value) => !value);
      return;
    }
    setCollapsed(false);
    void selectProject(project.id);
  };

  const actionVisibility = menuOpen
    ? "pointer-events-auto opacity-100"
    : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100";

  return (
    <div className="py-0.5">
      <div
        className={cn(
          "group flex w-full cursor-pointer flex-nowrap items-center gap-1.5 rounded-md px-3 py-1.5 text-left text-[12.5px] transition-colors hover:bg-white/[0.04]",
        )}
        title={displayPath(project.path)}
        aria-expanded={!collapsed}
        onClick={onHeaderClick}
      >
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-[#777] transition-transform",
            !collapsed && "rotate-90",
          )}
        />
        <StatusDot status={status} />
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-[#e8e8e8]">
          {project.name}
        </span>
        {/* 宽高始终留给 … 和新建会话。悬停只改透明度，不把会话列表顶开。 */}
        <div className="relative flex h-6 w-12 shrink-0 items-center justify-end">
          {runningCount ? (
            <span
              className={cn(
                "pointer-events-none absolute right-0 whitespace-nowrap rounded-full bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-medium text-sky-400",
                "group-hover:invisible group-focus-within:invisible",
                menuOpen && "invisible",
              )}
            >
              {runningCount} 活跃
            </span>
          ) : null}
          {!project.external && (
            <div ref={menuRef} className="relative">
              <button
                type="button"
                className={cn(
                  "flex h-6 w-6 items-center justify-center rounded text-[#888] hover:bg-white/10 hover:text-[#e8e8e8]",
                  actionVisibility,
                )}
                aria-label={`${project.name} 更多`}
                aria-expanded={menuOpen}
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen((open) => !open);
                }}
              >
                <Ellipsis className="h-4 w-4" />
              </button>
              {menuOpen && (
                <div className="absolute right-0 top-full z-30 mt-1 w-44 overflow-hidden rounded-xl border border-zinc-700/80 bg-zinc-900 py-1 shadow-xl shadow-black/40">
                  <button
                    type="button"
                    className={cn(
                      "block w-full px-3 py-2 text-left text-sm hover:bg-zinc-800",
                      confirming ? "text-red-300" : "text-zinc-200",
                    )}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirming) {
                        removeProject(project.id);
                        closeMenu();
                      } else {
                        setConfirming(true);
                      }
                    }}
                  >
                    {confirming ? "确认移除？" : "从列表移除"}
                  </button>
                </div>
              )}
            </div>
          )}
          <NewSessionButton
            projectId={project.id}
            className={cn(
              "flex h-6 w-6 items-center justify-center rounded text-[#888] hover:bg-white/10 hover:text-[#e8e8e8]",
              actionVisibility,
            )}
            title={`在 ${project.name} 中新建会话`}
          />
        </div>
      </div>
      {!collapsed && items.length > 0 && (
        <SessionList
          projectId={project.id}
          sessions={items}
          selected={selected}
          activeSessionId={activeSessionId}
          showAll={showAll}
          onToggleShowAll={() => setShowAll((value) => !value)}
        />
      )}
    </div>
  );
}
