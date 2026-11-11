import { useState } from "react";
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
  const [confirmRemove, setConfirmRemove] = useState(false);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[440px] gap-5 overflow-hidden rounded-2xl border-[var(--wb-border-strong)] bg-[var(--wb-elev)] p-6 outline-none [&>*]:min-w-0">
        <DialogHeader className="pr-6">
          <DialogTitle className="text-lg font-semibold tracking-tight text-[var(--wb-text-strong)]">
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
          <div className="flex min-w-0 items-center gap-2.5 rounded-xl border border-[var(--wb-border-strong)] bg-[var(--wb-well)] px-3 transition-colors focus-within:border-[var(--wb-accent)] focus-within:ring-2 focus-within:ring-[var(--wb-accent)]/20">
            <Folder className="h-4 w-4 shrink-0 text-[var(--wb-muted)]" />
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="项目名称"
              aria-label="项目名称"
              autoFocus
              className="h-11 w-full min-w-0 bg-transparent text-sm text-[var(--wb-text-strong)] outline-none placeholder:text-[var(--wb-faint)]"
            />
          </div>

          <div className="min-w-0">
            <div className="mb-2 text-sm text-[var(--wb-text)]">源文件夹</div>
            <div className="overflow-hidden rounded-xl border border-[var(--wb-border)] bg-[var(--wb-well)]">
              {folders.map((folder, index) => (
                <div
                  key={`${folder}-${index}`}
                  className="flex min-w-0 items-center gap-2 border-b border-[var(--wb-border)] px-3 py-2.5"
                >
                  <Folder className="h-4 w-4 shrink-0 text-[var(--wb-muted)]" aria-hidden="true" />
                  <span
                    className="min-w-0 flex-1 truncate text-sm text-[var(--wb-text)]"
                    title={folder}
                  >
                    {folder}
                  </span>
                  <button
                    type="button"
                    aria-label="移除文件夹"
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--wb-muted)] transition-colors hover:bg-[var(--wb-hover-strong)] hover:text-[var(--wb-text-strong)]"
                    onClick={() => removeFolder(index)}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm text-[var(--wb-text)] transition-colors hover:bg-[var(--wb-hover)] hover:text-[var(--wb-text-strong)]"
                onClick={() => void addFolder()}
              >
                <FolderPlus className="h-4 w-4 shrink-0 text-[var(--wb-muted)]" aria-hidden="true" />
                添加文件夹
              </button>
            </div>
          </div>

          {error && (
            <p className="rounded-lg border border-[var(--wb-danger-border)] bg-[var(--wb-danger-bg)] px-3 py-2 text-xs text-[var(--wb-danger-text)]">
              {error}
            </p>
          )}

          <div className="flex min-w-0 items-center justify-between gap-3 pt-1">
            <button
              type="button"
              className="rounded-md px-2 py-1 text-sm font-medium text-[var(--wb-danger-text)] transition-colors hover:bg-[var(--wb-danger-bg)] disabled:opacity-50"
              disabled={busy}
              onClick={() => {
                if (!confirmRemove) {
                  setConfirmRemove(true);
                  return;
                }
                void removeLocal();
              }}
            >
              {confirmRemove ? "确认移除项目？" : "移除本地项目"}
            </button>
            <div className="flex items-center gap-2.5">
              <Button type="button" variant="ghost" onClick={onClose}>
                取消
              </Button>
              <Button type="submit" disabled={!valid || busy}>
                {busy ? "处理中…" : "保存"}
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
