import { useCallback, useRef, useState, type RefObject } from "react";
import { ChevronRight, Ellipsis, Folder, Pin, PinOff, Settings, X } from "lucide-react";

import { cn, displayPath } from "@/lib/utils";
import { pendingSidebarSession } from "@/store/draft-session";
import { aggregateStatus, type Project } from "@/types";
import { FixedMenu } from "../FixedMenu";
import { useProjectItem } from "./use-project-item";
import { NewSessionButton } from "../sessions/NewSessionButton";
import { partitionSidebarSessions } from "../sessions/session-partition";
import { SessionList } from "../sessions/SessionList";
import { EditProjectDialog } from "./EditProjectDialog";
import { projectMenuItems, type ProjectMenuAction } from "./project-menu";
import { StatusDot } from "./StatusDot";
import { useProjectBranch } from "./use-project-branch";

export function ProjectItem({ project }: { project: Project }) {
  const {
    sessions,
    selected,
    activeSessionId,
    draft,
    pendingStart,
    draftFocused,
    selectProject,
    removeProject,
    openProjectFolder,
    pinned,
    togglePinnedProject,
  } = useProjectItem(project);
  const pending = pendingSidebarSession(project.id, draft, pendingStart);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    setConfirming(false);
  }, []);

  const items = pending ? [pending, ...(sessions ?? [])] : (sessions ?? []);
  const grouped = partitionSidebarSessions(items);
  const rowActiveId = draftFocused && pending ? pending.id : activeSessionId;
  const status = sessions ? aggregateStatus(grouped.active) : null;
  const branch = useProjectBranch(project.id);
  const highlightHeader = selected && (collapsed || grouped.active.length === 0);

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
    <>
      <div className="py-0.5">
        <div
          role="button"
          tabIndex={0}
          className={cn(
            "group relative flex w-full cursor-pointer flex-nowrap items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[12.5px] transition-colors hover:bg-[var(--wb-hover)] hover:pr-14 focus-within:pr-14 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--wb-accent)]/35",
            menuOpen && "bg-[var(--wb-hover)] pr-14",
            highlightHeader && "bg-[var(--wb-hover)]",
          )}
          title={displayPath(project.path)}
          aria-expanded={!collapsed}
          onClick={onHeaderClick}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onHeaderClick();
            }
          }}
          onContextMenu={(event) => {
            if (project.external) return;
            event.preventDefault();
            event.stopPropagation();
            setConfirming(false);
            setMenuOpen(true);
          }}
        >
          <ChevronRight
            className={cn(
              "h-3.5 w-3.5 shrink-0 text-[var(--wb-faint)] transition-transform",
              !collapsed && "rotate-90",
            )}
          />
          <StatusDot status={status} />
          <span className="max-w-[9.5rem] shrink-0 truncate text-[12.5px] font-medium text-[var(--wb-text-strong)]">
            {project.name}
          </span>
          {branch ? (
            <span
              data-project-branch={branch}
              title={branch}
              className="min-w-0 shrink truncate rounded-md bg-[var(--wb-chip)] px-1.5 text-[10px] leading-4 text-[var(--wb-muted)]"
            >
              {branch}
            </span>
          ) : null}
          <span className="min-w-0 flex-1" />
          {/* 悬停/展开菜单时标题行右侧自动留出 pr-14，避免长分支胶囊与操作钮碰撞或出现白块遮罩。 */}
          <div className="absolute right-1.5 top-1/2 z-10 flex h-6 w-12 -translate-y-1/2 items-center justify-end gap-0.5 rounded-md">
            {!project.external && (
              <div className="relative">
                <button
                  ref={anchorRef}
                  type="button"
                  className={cn(
                    "flex h-6 w-6 items-center justify-center rounded text-[var(--wb-muted)] transition-colors hover:bg-[var(--wb-hover-strong)] hover:text-[var(--wb-text-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--wb-accent)]/35",
                    menuOpen && "bg-[var(--wb-hover-strong)] text-[var(--wb-text-strong)]",
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
                  pinned={pinned}
                  confirming={confirming}
                  onClose={closeMenu}
                  onPin={() => {
                    closeMenu();
                    togglePinnedProject(project.id);
                  }}
                  onEdit={() => {
                    closeMenu();
                    setEditing(true);
                  }}
                  onOpenFolder={() => {
                    closeMenu();
                    void openProjectFolder(project.id);
                  }}
                  onRemove={() => {
                    if (confirming) {
                      removeProject(project.id);
                      closeMenu();
                    } else {
                      setConfirming(true);
                    }
                  }}
                />
              </div>
            )}
            <NewSessionButton
              projectId={project.id}
              className={cn(
                "flex h-6 w-6 items-center justify-center rounded text-[var(--wb-muted)] transition-colors hover:bg-[var(--wb-hover-strong)] hover:text-[var(--wb-text-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--wb-accent)]/35",
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
          />
        )}
      </div>
      {editing && <EditProjectDialog project={project} onClose={() => setEditing(false)} />}
    </>
  );
}

function ProjectMenu({
  open,
  anchorRef,
  project,
  pinned,
  confirming,
  onClose,
  onPin,
  onEdit,
  onOpenFolder,
  onRemove,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLButtonElement | null>;
  project: Project;
  pinned: boolean;
  confirming: boolean;
  onClose: () => void;
  onPin: () => void;
  onEdit: () => void;
  onOpenFolder: () => void;
  onRemove: () => void;
}) {
  const entries = projectMenuItems({ path: project.path, pinned });
  const wide = entries.some((entry) => entry.type === "action" && entry.id === "open-folder");
  return (
    <FixedMenu
      open={open}
      anchorRef={anchorRef}
      onClose={onClose}
      label={`${project.name} 菜单`}
      className={cn(
        "overflow-hidden rounded-xl border border-[var(--wb-border-strong)] bg-[var(--wb-elev)] py-1 shadow-[var(--wb-float-shadow)]",
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
              <div
                key={`sep-${index}`}
                role="separator"
                className="mx-2 my-1 border-t border-[var(--wb-border)]"
              />
            );
          }
          const danger = entry.id === "remove" && confirming;
          const label = danger ? "确认移除？" : entry.label;
          return (
            <button
              key={entry.id}
              type="button"
              role="menuitem"
              data-project-action={entry.id}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-[var(--wb-hover)] focus-visible:bg-[var(--wb-hover)] focus-visible:outline-none",
                danger ? "text-[var(--wb-danger-text)]" : "text-[var(--wb-text-strong)]",
              )}
              onClick={(event) => {
                event.stopPropagation();
                if (entry.id === "pin") onPin();
                else if (entry.id === "edit") onEdit();
                else if (entry.id === "open-folder") onOpenFolder();
                else onRemove();
              }}
            >
              <MenuIcon id={entry.id} pinned={pinned} danger={danger} />
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
  const className = cn(
    "h-4 w-4 shrink-0",
    danger ? "text-[var(--wb-danger-text)]" : "text-[var(--wb-muted)]",
  );
  if (id === "pin") {
    const Icon = pinned ? PinOff : Pin;
    return <Icon className={className} aria-hidden="true" />;
  }
  if (id === "edit") return <Settings className={className} aria-hidden="true" />;
  if (id === "open-folder") return <Folder className={className} aria-hidden="true" />;
  return <X className={className} aria-hidden="true" />;
}
