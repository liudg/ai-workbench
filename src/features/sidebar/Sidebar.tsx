import { AccountMenu } from "./account/AccountMenu";
import { BrandHeader } from "./brand/BrandHeader";
import { SidebarPeek } from "./SidebarPeek";
import { useSidebar } from "./use-sidebar";
import { useSidebarOpen } from "@/shared/shell/sidebar-open";
import { ChatGroup } from "./chats/ChatGroup";
import { ProjectHeader } from "./projects/ProjectHeader";
import { ProjectItem } from "./projects/ProjectItem";

export function Sidebar() {
  const open = useSidebarOpen();
  const frame = <SidebarFrame />;
  if (open) return frame;
  return <SidebarPeek>{frame}</SidebarPeek>;
}

function SidebarFrame() {
  const { pinned, unpinned, notice } = useSidebar();
  const noProjects = pinned.length === 0 && unpinned.length === 0;

  return (
    <aside
      data-sidebar-open=""
      className="flex h-full min-h-0 w-[260px] shrink-0 flex-col overflow-hidden bg-[var(--wb-sidebar)] px-1.5 text-[var(--wb-text)]"
    >
      <BrandHeader />

      <div
        data-sidebar-scroll
        className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto pb-2 [overflow-anchor:none]"
      >
        {pinned.length > 0 && (
          <section data-sidebar-section="pinned">
            <div className="flex items-center px-2.5 pb-1 pt-2.5">
              <span className="text-[11px] font-semibold tracking-[0.04em] text-[var(--wb-faint)]">置顶</span>
            </div>
            <div className="space-y-0.5">
              {pinned.map((project) => (
                <ProjectItem key={project.id} project={project} />
              ))}
            </div>
          </section>
        )}

        <div className="sticky top-0 z-20 bg-[var(--wb-sidebar)]">
          <ProjectHeader />
        </div>

        {noProjects ? (
          <div className="mx-1.5 mt-4 rounded-xl border border-dashed border-[var(--wb-border-strong)] px-3 py-6 text-center">
            <p className="text-xs leading-5 text-[var(--wb-faint)]">
              还没有项目。
              <br />
              点击上方 + 创建。
            </p>
          </div>
        ) : (
          <div className="space-y-0.5">
            {unpinned.map((project) => (
              <ProjectItem key={project.id} project={project} />
            ))}
          </div>
        )}
        <ChatGroup />
      </div>

      {notice && (
        <div className="mx-1.5 mb-2 flex items-center justify-between gap-2 rounded-xl border border-[var(--wb-border-strong)] bg-[var(--wb-elev)] px-3 py-2 text-xs text-[var(--wb-text)] shadow-sm">
          <span>{notice.text}</span>
        </div>
      )}

      <div className="relative z-10 px-2.5 py-2.5">
        <AccountMenu />
      </div>
    </aside>
  );
}
