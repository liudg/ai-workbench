import { TerminalSquare } from "lucide-react";

import { useWorkbench } from "@/store";
import { AccountMenu } from "./account/AccountMenu";
import { ProjectHeader } from "./projects/ProjectHeader";
import { ProjectItem } from "./projects/ProjectItem";

export function Sidebar() {
  const projects = useWorkbench((s) => s.projects);
  const notice = useWorkbench((s) => s.sidebarNotice);

  return (
    <aside className="flex w-72 shrink-0 flex-col border-r border-zinc-800/80 bg-zinc-900/30">
      <div className="flex items-center gap-2.5 px-4 pb-3 pt-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-cyan-400">
          <TerminalSquare className="h-4.5 w-4.5 text-white" strokeWidth={2.2} />
        </div>
        <div>
          <div className="text-sm font-semibold tracking-wide text-zinc-100">
            AI 工作台
          </div>
          <div className="text-[11px] text-zinc-500">多项目 · 多会话</div>
        </div>
      </div>

      <ProjectHeader />

      <div className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
        {projects.length === 0 ? (
          <div className="mx-2 mt-4 rounded-lg border border-dashed border-zinc-800 px-3 py-6 text-center">
            <p className="text-xs leading-5 text-zinc-500">
              还没有项目。
              <br />
              点击上方 + 创建。
            </p>
          </div>
        ) : (
          projects.map((p) => <ProjectItem key={p.id} project={p} />)
        )}
      </div>

      {notice && (
        <div className="mx-3 mb-2 flex items-center justify-between gap-2 rounded-lg border border-zinc-700/80 bg-zinc-900 px-3 py-2 text-xs text-zinc-200">
          <span>{notice.text}</span>
        </div>
      )}

      <div className="relative z-10 border-t border-zinc-800/80 px-3 py-3">
        <AccountMenu />
      </div>
    </aside>
  );
}
