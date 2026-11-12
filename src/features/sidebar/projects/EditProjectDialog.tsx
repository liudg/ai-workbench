import { Folder, FolderPlus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { Project } from "@/features/projects";
import { removeConfirmLabel } from "./project-menu";
import { useEditProjectForm } from "./useEditProjectForm";

export function EditProjectDialog({
  project,
  sessionCount,
  onClose,
}: {
  project: Project;
  sessionCount: number;
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
    confirmingRemove,
    error,
    busy,
    valid,
  } = useEditProjectForm(project, onClose);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[440px] gap-4 [&>*]:min-w-0">
        <DialogHeader className="pr-6">
          <DialogTitle>项目设置</DialogTitle>
          <DialogDescription>修改项目名称或关联的工作目录。</DialogDescription>
        </DialogHeader>

        <form
          className="min-w-0 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-wb-fg-2">项目名称</label>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="项目名称"
              aria-label="项目名称"
              autoFocus
            />
          </div>

          <div className="min-w-0 space-y-1.5">
            <div className="text-xs font-medium text-wb-fg-2">关联目录</div>
            <div className="overflow-hidden rounded-xl border border-wb-border bg-wb-elev/40">
              {folders.map((folder, index) => (
                <div
                  key={`${folder}-${index}`}
                  className="flex min-w-0 items-center gap-2 border-b border-wb-border px-3 py-2"
                >
                  <Folder className="h-4 w-4 shrink-0 text-wb-fg-3" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-wb-fg" title={folder}>
                    {folder}
                  </span>
                  <button
                    type="button"
                    aria-label="移除文件夹"
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-wb-fg-3 hover:bg-wb-hover hover:text-wb-fg"
                    onClick={() => removeFolder(index)}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-wb-fg-2 transition-colors hover:bg-wb-hover hover:text-wb-fg"
                onClick={() => void addFolder()}
              >
                <FolderPlus className="h-4 w-4 shrink-0 text-wb-fg-3" aria-hidden="true" />
                添加目录
              </button>
            </div>
          </div>

          {error && (
            <p className="rounded-lg border border-wb-danger/25 bg-wb-danger-soft px-3 py-2 text-xs text-wb-danger">
              {error}
            </p>
          )}

          <div className="flex min-w-0 items-center justify-between gap-3 pt-2">
            <button
              type="button"
              className="text-[13px] text-wb-danger hover:opacity-85 disabled:opacity-50"
              disabled={busy}
              onClick={() => void removeLocal()}
            >
              {confirmingRemove ? removeConfirmLabel(sessionCount) : "移除项目"}
            </button>
            <div className="flex items-center gap-2">
              <Button type="button" variant="ghost" onClick={onClose}>
                取消
              </Button>
              <Button type="submit" disabled={!valid || busy}>
                {busy ? "保存中…" : "保存"}
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
