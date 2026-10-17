import { Folder, FolderPlus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Project } from "@/types";
import { useEditProjectForm } from "./useEditProjectForm";

export function EditProjectDialog({
  project,
  onClose,
}: {
  project: Project;
  onClose: () => void;
}) {
  const {
    name,
    setName,
    folders,
    removeFolder,
    addFolder,
    submit,
    removeLocal,
    error,
    busy,
    valid,
  } = useEditProjectForm(project, onClose);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[440px] gap-5 overflow-hidden rounded-2xl border-zinc-700 bg-zinc-900 p-6 outline-none [&>*]:min-w-0">
        <DialogHeader className="pr-6">
          <DialogTitle className="text-lg font-semibold tracking-tight text-zinc-50">
            编辑项目
          </DialogTitle>
          <DialogDescription className="sr-only">修改项目名称和源文件夹。</DialogDescription>
        </DialogHeader>

        <form
          className="min-w-0 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="flex min-w-0 items-center gap-2.5 rounded-xl border border-zinc-600 bg-zinc-950/50 px-3 transition-colors focus-within:border-sky-500 focus-within:ring-1 focus-within:ring-sky-500/70">
            <Folder className="h-4 w-4 shrink-0 text-zinc-500" />
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="项目名称"
              aria-label="项目名称"
              autoFocus
              className="h-11 w-full min-w-0 bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
            />
          </div>

          <div className="min-w-0">
            <div className="mb-2 text-sm text-zinc-300">源文件夹</div>
            <div className="overflow-hidden rounded-xl border border-zinc-700">
              {folders.map((folder, index) => (
                <div
                  key={`${folder}-${index}`}
                  className="flex min-w-0 items-center gap-2 border-b border-zinc-800 px-3 py-2.5"
                >
                  <Folder className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate text-sm text-zinc-200" title={folder}>
                    {folder}
                  </span>
                  <button
                    type="button"
                    aria-label="移除文件夹"
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
                    onClick={() => removeFolder(index)}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm text-zinc-200 hover:bg-zinc-800"
                onClick={() => void addFolder()}
              >
                <FolderPlus className="h-4 w-4 shrink-0 text-zinc-400" aria-hidden="true" />
                添加文件夹
              </button>
            </div>
          </div>

          {error && (
            <p className="rounded-md border border-red-500/25 bg-red-500/[0.06] px-3 py-2 text-xs text-red-300">
              {error}
            </p>
          )}

          <div className="flex min-w-0 items-center justify-between gap-3 pt-1">
            <button
              type="button"
              className="text-sm text-red-300 hover:text-red-200 disabled:opacity-50"
              disabled={busy}
              onClick={() => void removeLocal()}
            >
              移除本地项目
            </button>
            <div className="flex items-center gap-3">
              <Button
                type="button"
                variant="ghost"
                className="text-zinc-400 hover:bg-transparent hover:text-zinc-200"
                onClick={onClose}
              >
                取消
              </Button>
              <Button
                type="submit"
                disabled={!valid || busy}
                className="rounded-lg bg-black px-4 text-white shadow-none hover:bg-zinc-800"
              >
                {busy ? "处理中…" : "保存"}
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
