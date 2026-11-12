import { FolderPlus, Search } from "lucide-react";

import { COMMAND_MENU_COPY } from "@/features/command-menu";
import { BrandHeader } from "@/shared/brand/BrandHeader";
import { ConnectionNotice } from "@/shared/shell/ConnectionNotice";
import { useSidebarOpen } from "@/shared/shell/sidebar-open";
import { AccountMenu } from "./account/AccountMenu";
import { BoardEntry } from "./BoardEntry";
import { ChatGroup } from "./chats/ChatGroup";
import { NewChatEntry } from "./NewChatEntry";
import { ProjectHeader } from "./projects/ProjectHeader";
import { ProjectItem } from "./projects/ProjectItem";
import { useProjectHeader } from "./projects/use-project-header";
import { SidebarPeek } from "./SidebarPeek";
import { useSidebar } from "./use-sidebar";

export function Sidebar() {
  const open = useSidebarOpen();
  const frame = <SidebarFrame />;
  if (open) return frame;
  return <SidebarPeek>{frame}</SidebarPeek>;
}

function SidebarFrame() {
  const { pinned, unpinned, loading, tasksOf, selectedProjectId, activeTaskId, notice, openCommandMenu } = useSidebar();
  const openProjectDialog = useProjectHeader();
  const noProjects = !loading && pinned.length === 0 && unpinned.length === 0;
  const standaloneTasks = tasksOf(null);
  const item = (project: (typeof pinned)[number]) => (
    <ProjectItem
      key={project.id}
      project={project}
      tasks={tasksOf(project.id)}
      selected={selectedProjectId === project.id}
      activeTaskId={activeTaskId}
    />
  );

  return (
    <aside
      data-sidebar-open=""
      className="flex h-full min-h-0 w-[256px] shrink-0 flex-col overflow-hidden bg-wb-sidebar text-wb-fg"
    >
      <BrandHeader action={<NewChatEntry />} />

      <div className="px-2.5 pb-1">
        <button
          type="button"
          data-sidebar-search=""
          aria-label={COMMAND_MENU_COPY.open}
          aria-keyshortcuts="Control+K Control+Shift+P"
          className="flex h-8 w-full items-center gap-2 rounded-lg border border-wb-border bg-wb-elev/70 px-2.5 text-left text-xs text-wb-fg-3 transition-colors hover:border-wb-border-strong hover:text-wb-fg-2"
          onClick={openCommandMenu}
        >
          <Search className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
          <span className="min-w-0 flex-1 truncate">搜索或跳转…</span>
          <kbd className="shrink-0 rounded border border-wb-border bg-wb-surface px-1 py-0.5 text-[10px] leading-none text-wb-fg-3">
            {COMMAND_MENU_COPY.shortcutOpen}
          </kbd>
        </button>
      </div>

      <BoardEntry />

      <div
        data-sidebar-scroll
        className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-1.5 pb-2 [overflow-anchor:none]"
      >
        {pinned.length > 0 && (
          <section data-sidebar-section="pinned" className="pt-2">
            <div className="flex items-center px-2 pb-1">
              <span className="text-[11px] font-medium tracking-wide text-wb-fg-3">置顶</span>
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
        <ChatGroup tasks={standaloneTasks} activeTaskId={activeTaskId} />
      </div>

      {notice && (
        <div className="mx-2.5 mb-2 flex items-center justify-between gap-2 rounded-lg border border-wb-border bg-wb-elev px-2.5 py-2 text-xs text-wb-fg">
          <span>{notice}</span>
        </div>
      )}

      <ConnectionNotice />
      <div className="relative z-10 border-t border-wb-border px-2.5 py-2">
        <AccountMenu />
      </div>
    </aside>
  );
}
