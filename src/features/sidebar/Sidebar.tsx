import { AccountMenu } from "./account/AccountMenu";
import { BrandHeader } from "./brand/BrandHeader";
import { useSidebar } from "./use-sidebar";
import { useSidebarOpen } from "./visibility";
import { ChatGroup } from "./chats/ChatGroup";
import { ProjectHeader } from "./projects/ProjectHeader";
import { ProjectItem } from "./projects/ProjectItem";

export function Sidebar() {
  const open = useSidebarOpen();
  const { pinned, unpinned, notice } = useSidebar();
  const noProjects = pinned.length === 0 && unpinned.length === 0;
  if (!open) return null;

  return (
    <aside
      data-sidebar-open=""
      className="flex h-full min-h-0 w-[260px] shrink-0 flex-col overflow-hidden border-r border-[#222] bg-[#141414]"
    >
      <BrandHeader />

      <div
        data-sidebar-scroll
        className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto pb-2 [overflow-anchor:none]"
      >
        {pinned.length > 0 && (
          <section data-sidebar-section="pinned">
            <div className="flex items-center px-3 pb-1.5 pt-2.5">
              <span className="text-[12px] text-[#cfcfcf]">置顶</span>
            </div>
            <div className="space-y-0.5">
              {pinned.map((project) => (
                <ProjectItem key={project.id} project={project} />
              ))}
            </div>
          </section>
        )}

        <div className="sticky top-0 z-20 bg-[#141414]">
          <ProjectHeader />
        </div>

        {noProjects ? (
          <div className="mx-2 mt-4 rounded-lg border border-dashed border-[#2a2a2a] px-3 py-6 text-center">
            <p className="text-xs leading-5 text-zinc-500">
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
        <div className="mx-3 mb-2 flex items-center justify-between gap-2 rounded-lg border border-[#2a2a2a] bg-[#1a1a1a] px-3 py-2 text-xs text-[#e8e8e8]">
          <span>{notice.text}</span>
        </div>
      )}

      <div className="relative z-10 px-3 py-3">
        <AccountMenu />
      </div>
    </aside>
  );
}
