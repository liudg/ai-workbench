import { useCallback, useRef, useState, type RefObject } from "react";
import { ChevronRight, Ellipsis, Folder, History, Pin, PinOff, Settings, X } from "lucide-react";

import type { Project } from "@/features/projects";
import { cn, displayPath } from "@/lib/utils";
import { AttentionPill, strongestPill } from "@/shared/attention";
import { FixedMenu } from "../FixedMenu";
import { NewSessionButton } from "../sessions/NewSessionButton";
import { partitionSidebarSessions } from "../sessions/session-partition";
import { SessionList } from "../sessions/SessionList";
import type { SidebarTask } from "../sidebar-task";
import { EditProjectDialog } from "./EditProjectDialog";
import { ImportSessionsDialog } from "./ImportSessionsDialog";
import { projectMenuItems, removeConfirmLabel, type ProjectMenuAction } from "./project-menu";
import { useProjectBranch } from "./use-project-branch";
import { useProjectItem } from "./use-project-item";

export function ProjectItem({
  project,
  tasks,
  selected,
  activeTaskId,
}: {
  project: Project;
  tasks: readonly SidebarTask[];
  selected: boolean;
  activeTaskId: string | null;
}) {
  const { selectProject, togglePinned, openFolder, removeProject } = useProjectItem(project, tasks);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    setConfirming(false);
  }, []);

  const grouped = partitionSidebarSessions(tasks);
  const pill = strongestPill(grouped.active.map((task) => task.attention));
  const branch = useProjectBranch(project.id);

  const onHeaderClick = () => {
    if (selected) {
      setCollapsed((value) => !value);
      return;
    }
    setCollapsed(false);
    selectProject();
  };

  const actionVisibility = menuOpen
    ? "pointer-events-auto opacity-100"
    : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100";

  return (
    <>
    <div className="py-0.5">
      <div
        className={cn(
          "group relative flex w-full cursor-pointer flex-nowrap items-center gap-1.5 rounded-md px-3 py-1.5 pr-2 text-left text-[12.5px] transition-colors hover:bg-white/[0.04]",
        )}
        title={displayPath(project.path)}
        aria-expanded={!collapsed}
        onClick={onHeaderClick}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setConfirming(false);
          setMenuOpen(true);
        }}
      >
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-[#777] transition-transform",
            !collapsed && "rotate-90",
          )}
        />
        <span className="flex w-1.5 shrink-0 justify-center">
          <AttentionPill pill={pill} compact />
        </span>
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
          <div className="relative">
              <button
                ref={anchorRef}
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
              <ProjectMenu
                  open={menuOpen}
                  anchorRef={anchorRef}
                  project={project}
                  sessionCount={tasks.length}
                  confirming={confirming}
                  onClose={closeMenu}
                  onPin={() => {
                    closeMenu();
                    togglePinned();
                  }}
                  onEdit={() => {
                    closeMenu();
                    setEditing(true);
                  }}
                  onImport={() => {
                    closeMenu();
                    setImporting(true);
                  }}
                  onOpenFolder={() => {
                    closeMenu();
                    openFolder();
                  }}
                  onRemove={() => {
                    if (confirming) {
                      removeProject();
                      closeMenu();
                    } else {
                      setConfirming(true);
                    }
                  }}
                />
          </div>
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
        <SessionList tasks={grouped.active} activeTaskId={activeTaskId} />
      )}
    </div>
    {editing && (
      <EditProjectDialog project={project} sessionCount={tasks.length} onClose={() => setEditing(false)} />
    )}
    {importing && <ImportSessionsDialog project={project} onClose={() => setImporting(false)} />}
    </>
  );
}

function ProjectMenu({
  open,
  anchorRef,
  project,
  sessionCount,
  confirming,
  onClose,
  onPin,
  onEdit,
  onImport,
  onOpenFolder,
  onRemove,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLButtonElement | null>;
  project: Project;
  sessionCount: number;
  confirming: boolean;
  onClose: () => void;
  onPin: () => void;
  onEdit: () => void;
  onImport: () => void;
  onOpenFolder: () => void;
  onRemove: () => void;
}) {
  const pinned = project.pinned;
  const entries = projectMenuItems({ path: project.path, pinned });
  const wide =
    (confirming && sessionCount > 0) ||
    entries.some((entry) => entry.type === "action" && entry.id === "open-folder");
  return (
    <FixedMenu
      open={open}
      anchorRef={anchorRef}
      onClose={onClose}
      label={`${project.name} 菜单`}
      className={cn(
        "overflow-hidden rounded-xl border border-zinc-700/80 bg-zinc-900 py-1 shadow-xl shadow-black/40",
        wide ? "w-56" : "w-44",
      )}
    >
      <div
        data-project-menu
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
      {entries.map((entry, index) => {
        if (entry.type === "separator") {
          return (
            <div key={`sep-${index}`} role="separator" className="mx-2 my-1 border-t border-zinc-800" />
          );
        }
        const label = entry.id === "remove" && confirming ? removeConfirmLabel(sessionCount) : entry.label;
        return (
          <button
            key={entry.id}
            type="button"
            role="menuitem"
            data-project-action={entry.id}
            className={cn(
              "flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-zinc-800",
              entry.id === "remove" && confirming ? "text-red-300" : "text-zinc-200",
            )}
            onClick={(event) => {
              event.stopPropagation();
              if (entry.id === "pin") onPin();
              else if (entry.id === "edit") onEdit();
              else if (entry.id === "import") onImport();
              else if (entry.id === "open-folder") onOpenFolder();
              else onRemove();
            }}
          >
            <MenuIcon id={entry.id} pinned={pinned} danger={entry.id === "remove" && confirming} />
            <span className="whitespace-nowrap">{label}</span>
          </button>
        );
      })}
      </div>
    </FixedMenu>
  );
}

function MenuIcon({
  id,
  pinned,
  danger,
}: {
  id: ProjectMenuAction;
  pinned: boolean;
  danger: boolean;
}) {
  const className = cn("h-4 w-4 shrink-0", danger ? "text-red-300" : "text-zinc-400");
  if (id === "pin") {
    const Icon = pinned ? PinOff : Pin;
    return <Icon className={className} aria-hidden="true" />;
  }
  if (id === "edit") return <Settings className={className} aria-hidden="true" />;
  if (id === "import") return <History className={className} aria-hidden="true" />;
  if (id === "open-folder") return <Folder className={className} aria-hidden="true" />;
  return <X className={className} aria-hidden="true" />;
}
