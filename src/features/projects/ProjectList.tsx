import { Folder, Plus, X } from "lucide-react";

import { cn } from "@/lib/utils";
import type { Project } from "./types";

const iconButton =
  "flex h-7 w-7 items-center justify-center rounded-md text-[#888] transition-colors hover:bg-white/5 hover:text-[#e8e8e8]";

export function ProjectList({
  projects,
  loading,
  selectedId,
  error,
  onSelect,
  onAdd,
  onRemove,
  onDismissError,
}: {
  projects: Project[];
  loading: boolean;
  selectedId: string | null;
  error: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  onDismissError: () => void;
}) {
  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between px-3 pb-1.5 pt-2.5">
        <span className="text-[12px] text-[#cfcfcf]">项目</span>
        <button type="button" className={iconButton} aria-label="添加项目" title="添加项目" onClick={onAdd}>
          <Plus className="h-[18px] w-[18px]" strokeWidth={2} />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto pb-2">
        {!loading && projects.length === 0 && (
          <div className="mx-2 mt-4 rounded-lg border border-dashed border-[#2a2a2a] px-3 py-6 text-center">
            <p className="text-xs leading-5 text-zinc-500">
              还没有项目。
              <br />
              点击上方 + 添加。
            </p>
          </div>
        )}
        {projects.map((project) => (
          <div
            key={project.id}
            role="button"
            tabIndex={0}
            title={project.path}
            aria-current={project.id === selectedId ? "true" : undefined}
            className={cn(
              "group mx-1 flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[12.5px] transition-colors hover:bg-white/[0.04]",
              project.id === selectedId && "bg-white/[0.07]",
            )}
            onClick={() => onSelect(project.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect(project.id);
              }
            }}
          >
            <Folder className="h-3.5 w-3.5 shrink-0 text-[#777]" />
            <span className="min-w-0 flex-1 truncate text-[#e8e8e8]">{project.name}</span>
            <button
              type="button"
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[#777] opacity-0 transition-opacity hover:bg-white/10 hover:text-[#e8e8e8] focus:opacity-100 group-hover:opacity-100"
              aria-label={`移除项目 ${project.name}`}
              title="从列表移除（不删除文件）"
              onClick={(event) => {
                event.stopPropagation();
                onRemove(project.id);
              }}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>

      {error && (
        <div className="mx-3 mb-2 flex items-start justify-between gap-2 rounded-lg border border-[#3a2a2a] bg-[#1f1616] px-3 py-2 text-xs text-[#f0c4c4]">
          <span className="min-w-0 break-words">{error}</span>
          <button type="button" aria-label="关闭" className="shrink-0 text-[#a88]" onClick={onDismissError}>
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </section>
  );
}
