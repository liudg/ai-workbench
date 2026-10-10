import { useEffect, useRef, useState, type RefObject } from "react";
import { Ellipsis, Plus, RefreshCw, TerminalSquare, Trash2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { APP_VERSION } from "@/lib/version";
import { useWorkbench } from "@/store";
import { aggregateStatus, type Project } from "@/types";
import { StatusDot } from "./StatusDot";

function useDismiss(
  open: boolean,
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
) {
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, ref, onClose]);
}

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

function ProjectHeader() {
  const openDialog = useWorkbench((s) => s.openDialog);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeMenu = () => setMenuOpen(false);
  useDismiss(menuOpen, menuRef, closeMenu);

  return (
    <div className="flex items-center justify-between px-3 pb-1 pt-2">
      <span className="px-1 text-[13px] font-medium text-zinc-300">项目</span>
      <div className="flex items-center gap-1">
        <div ref={menuRef} className="relative">
          <button
            type="button"
            className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-200 transition-colors hover:bg-zinc-800/70 hover:text-white"
            aria-label="更多"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <Ellipsis className="h-4 w-4" strokeWidth={2} />
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-full z-30 mt-1 w-36 rounded-xl border border-zinc-700/80 bg-zinc-900 px-3 py-2 text-xs text-zinc-500 shadow-xl shadow-black/40">
              暂无更多操作
            </div>
          )}
        </div>
        <button
          type="button"
          className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-100 transition-colors hover:bg-zinc-800/70 hover:text-white"
          aria-label="创建项目"
          title="创建项目"
          onClick={() => openDialog("create")}
        >
          <Plus className="h-[18px] w-[18px]" strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}

function AccountMenu() {
  const checkUpdates = useWorkbench((s) => s.checkUpdates);
  const checking = useWorkbench((s) => s.update.kind === "checking");
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const close = () => setOpen(false);
  useDismiss(open, rootRef, close);

  return (
    <div ref={rootRef} className="relative">
      {open && (
        <div className="absolute bottom-full left-0 z-30 mb-2 w-56 overflow-hidden rounded-2xl border border-zinc-700/80 bg-zinc-900 py-1.5 shadow-2xl shadow-black/50">
          <button
            type="button"
            className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left text-sm text-zinc-100 transition-colors hover:bg-zinc-800/90"
            onClick={() => {
              setOpen(false);
              checkUpdates(true);
            }}
          >
            <RefreshCw
              className={cn(
                "h-4 w-4 shrink-0 text-zinc-400",
                checking && "animate-spin",
              )}
            />
            <span className="min-w-0 flex-1">检查更新</span>
            <span className="text-xs text-zinc-500">v{APP_VERSION}</span>
          </button>
        </div>
      )}
      <button
        type="button"
        className={cn(
          "flex h-8 w-8 items-center justify-center rounded-full border bg-zinc-800 text-xs font-semibold text-zinc-100 transition-colors hover:bg-zinc-700",
          open ? "border-zinc-500" : "border-zinc-600",
        )}
        aria-label="打开菜单"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((value) => !value)}
      >
        A
      </button>
    </div>
  );
}

export function Sidebar() {
  const projects = useWorkbench((s) => s.projects);

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

      <div className="relative z-10 border-t border-zinc-800/80 px-3 py-3">
        <AccountMenu />
      </div>
    </aside>
  );
}
