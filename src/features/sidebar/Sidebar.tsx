import { AccountMenu } from "./account/AccountMenu";
import { BrandHeader } from "./brand/BrandHeader";
import { useSidebar } from "./use-sidebar";
import { ProjectHeader } from "./projects/ProjectHeader";
import { ProjectItem } from "./projects/ProjectItem";

export function Sidebar() {
  const { projects, notice } = useSidebar();

  return (
    <aside className="flex h-full min-h-0 w-[260px] shrink-0 flex-col overflow-hidden border-r border-[#222] bg-[#141414]">
      <BrandHeader />

      <ProjectHeader />

      <div
        data-sidebar-scroll
        className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto pb-2 [overflow-anchor:none]"
      >
        {projects.length === 0 ? (
          <div className="mx-2 mt-4 rounded-lg border border-dashed border-[#2a2a2a] px-3 py-6 text-center">
            <p className="text-xs leading-5 text-zinc-500">
              还没有项目。
              <br />
              点击上方 + 创建。
            </p>
          </div>
        ) : (
          <div className="space-y-0.5">
            {projects.map((p) => (
              <ProjectItem key={p.id} project={p} />
            ))}
          </div>
        )}
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
