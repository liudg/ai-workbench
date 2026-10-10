import { useState } from "react";
import { FolderPlus, Import, RefreshCw, TerminalSquare, Trash2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { APP_VERSION } from "@/lib/version";
import { useWorkbench } from "@/store";
import { aggregateStatus, type Project } from "@/types";
import { Button } from "./ui/button";
import { StatusDot } from "./StatusDot";

function ProjectItem({ project }: { project: Project }) {
  const sessions = useWorkbench((s) => s.sessions[project.id]);
  const selected = useWorkbench((s) => s.selectedProjectId === project.id);
  const selectProject = useWorkbench((s) => s.selectProject);
  const removeProject = useWorkbench((s) => s.removeProject);
  const [confirming, setConfirming] = useState(false);

  const status = sessions ? aggregateStatus(sessions) : null;
  const runningCount = sessions?.filter(
    (s) => s.status === "running" || s.status === "needs-input",
  ).length;

  return (
    <div
      className={cn(
        "group relative flex w-full cursor-pointer flex-col gap-0.5 rounded-lg px-3 py-2.5 text-left transition-colors",
        selected ? "bg-zinc-800/80" : "hover:bg-zinc-800/40",
      )}
      onClick={() => selectProject(project.id)}
    >
      <div className="flex items-center gap-2">
        <StatusDot status={status} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-200">
          {project.name}
        </span>
        {runningCount ? (
          <span className="rounded-full bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-medium text-sky-400">
            {runningCount} 活跃
          </span>
        ) : null}
        <button
          className="hidden rounded p-1 text-zinc-500 hover:bg-zinc-700 hover:text-zinc-300 group-hover:block"
          title="从列表移除（不删除磁盘文件）"
          onClick={(e) => {
            e.stopPropagation();
            if (confirming) {
              removeProject(project.id);
            } else {
              setConfirming(true);
              setTimeout(() => setConfirming(false), 2500);
            }
          }}
        >
          {confirming ? (
            <span className="px-0.5 text-[10px] text-red-400">确认?</span>
          ) : (
            <Trash2 className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
      <div className="truncate pl-4 text-xs text-zinc-500" title={project.path}>
        {project.path}
      </div>
    </div>
  );
}

function UpdateButton() {
  const checkUpdates = useWorkbench((s) => s.checkUpdates);
  const checking = useWorkbench((s) => s.update.kind === "checking");

  return (
    <button
      onClick={() => checkUpdates(true)}
      className="flex w-full items-center justify-between rounded-md px-3 py-1.5 text-[11px] text-zinc-600 transition-colors hover:bg-zinc-800/50 hover:text-zinc-400"
      title="检查应用更新"
    >
      <span className="flex items-center gap-1.5">
        <RefreshCw className={cn("h-3 w-3", checking && "animate-spin")} />
        检查更新
      </span>
      <span>v{APP_VERSION}</span>
    </button>
  );
}

export function Sidebar() {
  const projects = useWorkbench((s) => s.projects);
  const openDialog = useWorkbench((s) => s.openDialog);

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

      <div className="flex items-center justify-between px-4 pb-1 pt-2">
        <span className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
          项目
        </span>
        <span className="text-[11px] text-zinc-600">{projects.length}</span>
      </div>

      <div className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
        {projects.length === 0 ? (
          <div className="mx-2 mt-4 rounded-lg border border-dashed border-zinc-800 px-3 py-6 text-center">
            <p className="text-xs leading-5 text-zinc-500">
              还没有项目。
              <br />
              新建一个，或导入现有文件夹。
            </p>
          </div>
        ) : (
          projects.map((p) => <ProjectItem key={p.id} project={p} />)
        )}
      </div>

      <div className="space-y-1.5 border-t border-zinc-800/80 p-3">
        <Button
          variant="secondary"
          className="w-full justify-start"
          onClick={() => openDialog("create")}
        >
          <FolderPlus /> 新建项目
        </Button>
        <Button
          variant="ghost"
          className="w-full justify-start"
          onClick={() => openDialog("import")}
        >
          <Import /> 导入文件夹
        </Button>
        <UpdateButton />
      </div>
    </aside>
  );
}
