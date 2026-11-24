import { useEffect, useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { FolderPlus, Search, X } from "lucide-react";

import { useNeedsYouCount } from "@/features/board";
import { COMMAND_MENU_COPY } from "@/features/command-menu";
import { cn } from "@/lib/utils";
import {
  buildWhenContext,
  getResolvedKeybindings,
  matchesCommandBinding,
  useCommandShortcut,
} from "@/shared/keybindings";
import { ConnectionNotice } from "@/shared/shell/ConnectionNotice";
import { useSidebarOpen } from "@/shared/shell/sidebar-open";
import { AccountMenu } from "./account/AccountMenu";
import { BoardEntry } from "./BoardEntry";
import { ChatGroup } from "./chats/ChatGroup";
import { NewChatEntry } from "./NewChatEntry";
import { ProjectHeader } from "./projects/ProjectHeader";
import { ProjectItem } from "./projects/ProjectItem";
import { useProjectHeader } from "./projects/use-project-header";
import { SidebarSearchResults } from "./search/SidebarSearchResults";
import { useSidebarSearch } from "./search/use-sidebar-search";
import { SidebarPeek } from "./SidebarPeek";
import { useSidebarViewStore } from "./sidebar-view-store";
import { useModHold } from "./useModHold";
import { useSidebar } from "./use-sidebar";
import { visibleTasksFromSections } from "./visible-sessions";

const EMPTY_JUMP_MAP: ReadonlyMap<string, number> = new Map();

export function Sidebar() {
  const open = useSidebarOpen();
  const needsYouCount = useNeedsYouCount();
  const frame = <SidebarFrame />;
  if (open) return frame;
  return <SidebarPeek needsYou={needsYouCount > 0}>{frame}</SidebarPeek>;
}

function SidebarFrame() {
  const {
    projects,
    pinned,
    unpinned,
    loading,
    tasksOf,
    selectedProjectId,
    activeTaskId,
    notice,
    openCommandMenu,
  } = useSidebar();
  const openProjectDialog = useProjectHeader();
  const commandMenuShortcut = useCommandShortcut("commandMenu.toggle");
  const modHeld = useModHold();
  const collapsedProjects = useSidebarViewStore((state) => state.collapsedProjects);
  const chatsCollapsed = useSidebarViewStore((state) => state.chatsCollapsed);
  const visibleLimitByScope = useSidebarViewStore((state) => state.visibleLimitByScope);
  const collapsedSubtasks = useSidebarViewStore((state) => state.collapsedSubtasks);
  const search = useSidebarSearch();
  const asideRef = useRef<HTMLElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const selectedProjectIdRef = useRef(selectedProjectId);
  selectedProjectIdRef.current = selectedProjectId;

  const jumpIndexByTaskId = useMemo<ReadonlyMap<string, number>>(() => {
    if (!modHeld || search.isSearching) return EMPTY_JUMP_MAP;
    const visibleTasks = visibleTasksFromSections(
      { pinned, unpinned, tasksOf },
      { collapsedProjects, chatsCollapsed, visibleLimitByScope, collapsedSubtasks },
    );
    if (visibleTasks.length === 0) return EMPTY_JUMP_MAP;
    const map = new Map<string, number>();
    visibleTasks.slice(0, 9).forEach((task, idx) => {
      map.set(task.id, idx + 1);
    });
    return map;
  }, [
    chatsCollapsed,
    collapsedProjects,
    collapsedSubtasks,
    modHeld,
    pinned,
    search.isSearching,
    tasksOf,
    unpinned,
    visibleLimitByScope,
  ]);

  useEffect(() => {
    const focusInput = () => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      const target = event.target;
      if (!(target instanceof Node) || !asideRef.current?.contains(target)) return;
      if (
        typeof document !== "undefined" &&
        document.querySelector(
          "[data-keybinding-recording='true'], [data-command-menu], [data-file-search], [role='dialog'], [role='alertdialog']",
        )
      ) {
        return;
      }
      const context = buildWhenContext({
        sessionActive: true,
        projectActive: Boolean(selectedProjectIdRef.current),
        target,
      });
      if (!matchesCommandBinding("chat.find", event, context, getResolvedKeybindings())) return;
      event.preventDefault();
      event.stopPropagation();
      focusInput();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);

  const onSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (search.query.length > 0) {
        search.clearSearch();
      }
      searchInputRef.current?.blur();
      return;
    }
    if (!search.isSearching) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (search.hits.length > 0) {
        search.setActiveIndex(Math.min(search.hits.length - 1, search.activeIndex + 1));
      }
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (search.hits.length > 0) {
        search.setActiveIndex(Math.max(0, search.activeIndex - 1));
      }
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const hit = search.hits[search.activeIndex];
      if (hit) {
        search.selectHit(hit);
      }
    }
  };

  const noProjects = !loading && pinned.length === 0 && unpinned.length === 0;
  const standaloneTasks = tasksOf(null);
  const searchTooltip = commandMenuShortcut
    ? `${COMMAND_MENU_COPY.open} (${commandMenuShortcut})`
    : COMMAND_MENU_COPY.open;

  const item = (project: (typeof pinned)[number]) => (
    <ProjectItem
      key={project.id}
      project={project}
      tasks={tasksOf(project.id)}
      selected={selectedProjectId === project.id}
      activeTaskId={activeTaskId}
      jumpIndexByTaskId={jumpIndexByTaskId}
    />
  );

  return (
    <aside
      ref={asideRef}
      data-sidebar-open=""
      className="flex h-full min-h-0 w-[244px] shrink-0 flex-col overflow-hidden bg-wb-sidebar text-wb-fg"
    >
      <div className="space-y-0.5 p-2">
        <NewChatEntry />
        <div data-sidebar-search="" className="space-y-1">
          <div className="flex h-8 w-full items-center gap-2 rounded-lg border border-transparent px-2 text-[13px] text-wb-fg transition-colors hover:bg-wb-hover focus-within:border-wb-border-strong focus-within:bg-wb-input">
            <Search className="h-3.5 w-3.5 shrink-0 text-wb-fg-3" strokeWidth={1.8} aria-hidden="true" />
            <input
              ref={searchInputRef}
              type="text"
              data-sidebar-search-input=""
              value={search.query}
              placeholder="搜索全部会话与消息…"
              aria-label="搜索全部会话与消息"
              onChange={(event) => search.setQuery(event.target.value)}
              onKeyDown={onSearchKeyDown}
              className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-wb-fg outline-none placeholder:text-wb-fg-3"
            />
            {search.query.length > 0 ? (
              <button
                type="button"
                data-sidebar-search-clear=""
                aria-label="清空搜索"
                onClick={() => {
                  search.clearSearch();
                  searchInputRef.current?.focus();
                }}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-wb-fg-3 transition-colors hover:bg-wb-hover hover:text-wb-fg"
              >
                <X className="h-3.5 w-3.5" strokeWidth={1.8} />
              </button>
            ) : commandMenuShortcut ? (
              <button
                type="button"
                title={searchTooltip}
                aria-label={COMMAND_MENU_COPY.open}
                aria-keyshortcuts="Control+K Control+Shift+P"
                onClick={openCommandMenu}
                className="shrink-0 rounded border border-wb-border bg-wb-elev/70 px-1.5 py-0.5 font-mono text-[11px] leading-none text-wb-fg-3 transition-colors hover:bg-wb-hover hover:text-wb-fg"
              >
                {commandMenuShortcut}
              </button>
            ) : null}
          </div>

          {search.isSearching ? (
            <div className="flex items-center justify-between gap-2 px-1 pt-0.5">
              <span className="truncate text-[11px] text-wb-fg-3">
                {search.loading ? "正在搜索…" : `共 ${search.hits.length} 条匹配`}
              </span>
              <button
                type="button"
                data-sidebar-search-archived=""
                aria-pressed={search.includeArchived}
                onClick={search.toggleIncludeArchived}
                className={cn(
                  "shrink-0 rounded-md border px-1.5 py-0.5 text-[11px] leading-4 transition-colors",
                  search.includeArchived
                    ? "wb-menu-active font-medium text-wb-accent-ink"
                    : "border-wb-border bg-wb-elev/60 text-wb-fg-3 hover:bg-wb-hover hover:text-wb-fg",
                )}
              >
                含已归档
              </button>
            </div>
          ) : null}
        </div>
        <BoardEntry />
      </div>

      <div
        data-sidebar-scroll
        className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-2 pb-2 [overflow-anchor:none]"
      >
        {search.isSearching ? (
          <SidebarSearchResults
            query={search.trimmedQuery}
            hits={search.hits}
            loading={search.loading}
            activeIndex={search.activeIndex}
            projects={projects}
            onActiveIndex={search.setActiveIndex}
            onSelectHit={search.selectHit}
          />
        ) : (
          <>
            {pinned.length > 0 && (
              <section data-sidebar-section="pinned" className="pb-1.5 pt-1.5">
                <div className="px-2 pb-1">
                  <span className="wb-group-header">置顶</span>
                </div>
                <div className="space-y-0.5">{pinned.map(item)}</div>
              </section>
            )}

            <div className="sticky top-0 z-20 bg-wb-sidebar">
              <ProjectHeader />
            </div>

            {noProjects ? (
              <div className="px-1.5 pt-1">
                <button
                  type="button"
                  onClick={() => openProjectDialog("import")}
                  className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-wb-border-strong px-3 py-4 text-xs text-wb-fg-2 transition-colors hover:border-wb-accent/50 hover:bg-wb-hover hover:text-wb-fg"
                >
                  <FolderPlus className="h-3.5 w-3.5 shrink-0 text-wb-fg-3" />
                  <span>添加项目目录</span>
                </button>
              </div>
            ) : (
              <div className="space-y-0.5">{unpinned.map(item)}</div>
            )}
            <ChatGroup tasks={standaloneTasks} activeTaskId={activeTaskId} jumpIndexByTaskId={jumpIndexByTaskId} />
          </>
        )}
      </div>

      {notice && (
        <div className="mx-2.5 mb-2 flex items-center justify-between gap-2 rounded-lg border border-wb-border bg-wb-elev px-2.5 py-2 text-xs text-wb-fg">
          <span>{notice}</span>
        </div>
      )}

      <ConnectionNotice />
      <div className="relative z-10 border-t border-wb-border p-2.5">
        <AccountMenu />
      </div>
    </aside>
  );
}
