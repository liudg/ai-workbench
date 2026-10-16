import { useCallback, useRef, useState } from "react";
import { ChevronRight, Ellipsis } from "lucide-react";

import { cn, displayPath } from "@/lib/utils";
import { pendingSidebarSession } from "@/store/draft-session";
import { aggregateStatus, type Project } from "@/types";
import { useProjectItem } from "./use-project-item";
import { useDismiss } from "../use-dismiss";
import { NewSessionButton } from "../sessions/NewSessionButton";
import { partitionSidebarSessions } from "../sessions/session-partition";
import { SessionList } from "../sessions/SessionList";
import { StatusDot } from "./StatusDot";
import { useProjectBranch } from "./use-project-branch";

export function ProjectItem({ project }: { project: Project }) {
  const { sessions, selected, activeSessionId, draft, pendingStart, draftFocused, selectProject, removeProject } =
    useProjectItem(project);
  const pending = pendingSidebarSession(project.id, draft, pendingStart);
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

  const items = pending ? [pending, ...(sessions ?? [])] : (sessions ?? []);
  const grouped = partitionSidebarSessions(items);
  const rowActiveId = draftFocused && pending ? pending.id : activeSessionId;
  const status = sessions ? aggregateStatus(grouped.active) : null;
  const branch = useProjectBranch(project.id);

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
          "group relative flex w-full cursor-pointer flex-nowrap items-center gap-1.5 rounded-md px-3 py-1.5 pr-2 text-left text-[12.5px] transition-colors hover:bg-white/[0.04]",
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
        <span className="max-w-[9.5rem] shrink-0 truncate text-[12.5px] text-[#e8e8e8]">{project.name}</span>
        {branch ? (
          <span
            data-project-branch={branch}
            title={branch}
            className="min-w-0 shrink truncate rounded-md bg-[#2a2a2a] px-1.5 text-[10px] leading-4 text-[#9a9a9a]"
          >
            {branch}
          </span>
        ) : null}
        <span className="min-w-0 flex-1" />
        {/* 操作钮叠在行尾。短分支留在名字旁边；长分支用剩余宽度，悬停时不把下面的会话顶开。 */}
        <div className="absolute right-1.5 top-[calc(50%-12px)] z-10 flex h-6 w-12 items-center justify-end rounded-md group-hover:bg-[#1b1b1b] group-focus-within:bg-[#1b1b1b]">
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
      {!collapsed && grouped.active.length > 0 && (
        <SessionList
          projectId={project.id}
          sessions={grouped.active}
          selected={selected}
          activeSessionId={rowActiveId}
          showAll={showAll}
          onToggleShowAll={() => setShowAll((value) => !value)}
        />
      )}
    </div>
  );
}
