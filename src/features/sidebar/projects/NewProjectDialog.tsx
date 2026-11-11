import { ChevronDown, Folder, FolderPlus } from "lucide-react";

import { cn } from "@/lib/utils";
import { useDismiss } from "../use-dismiss";
import { useNewProjectForm } from "./useNewProjectForm";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function NewProjectDialog() {
  const form = useNewProjectForm();
  const {
    dialog,
    closeDialog,
    lastError,
    name,
    setName,
    dir,
    source,
    setSource,
    sourceMenu,
    setSourceMenu,
    initGit,
    setInitGit,
    busy,
    sourceRef,
    closeSourceMenu,
    pickDir,
    submit,
    valid,
    sourceLabel,
  } = form;
  useDismiss(sourceMenu, sourceRef, closeSourceMenu);

  return (
    <Dialog open={dialog !== null} onOpenChange={(open) => !open && closeDialog()}>
      <DialogContent
        className="max-w-[440px] gap-5 overflow-hidden rounded-2xl border-[var(--wb-border-strong)] bg-[var(--wb-elev)] p-6 outline-none [&>*]:min-w-0"
        onEscapeKeyDown={(event) => {
          if (sourceMenu) {
            event.preventDefault();
            setSourceMenu(false);
          }
        }}
      >
        <DialogHeader className="pr-6">
          <DialogTitle className="text-lg font-semibold tracking-tight text-[var(--wb-text-strong)]">
            {source === "import" ? "导入项目" : "创建项目"}
          </DialogTitle>
          <DialogDescription className="sr-only">
            填写项目名称，并在此电脑上添加源文件夹。
          </DialogDescription>
        </DialogHeader>

        <form
          className="min-w-0 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="flex min-w-0 items-center gap-2.5 rounded-xl border border-[var(--wb-border-strong)] bg-[var(--wb-well)] px-3 transition-colors focus-within:border-[var(--wb-accent)] focus-within:ring-1 focus-within:ring-[var(--wb-accent)]/45">
            <Folder className="h-4 w-4 shrink-0 text-[var(--wb-muted)]" />
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="项目名称"
              autoFocus
              className="h-11 w-full min-w-0 bg-transparent text-sm text-[var(--wb-text-strong)] outline-none placeholder:text-[var(--wb-faint)]"
            />
          </div>

          <div className="min-w-0">
            <div className="mb-2 text-sm text-[var(--wb-text)]">源文件夹</div>
            <div className="min-w-0 rounded-xl border border-[var(--wb-border)] bg-[var(--wb-well)] px-4 py-7 text-center">
              <div ref={sourceRef} className="relative inline-flex">
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-sm text-[var(--wb-text)] hover:text-[var(--wb-text-strong)]"
                  aria-expanded={sourceMenu}
                  onClick={() => setSourceMenu((open) => !open)}
                >
                  {sourceLabel}
                  <ChevronDown className="h-3.5 w-3.5 text-[var(--wb-muted)]" />
                </button>
                {sourceMenu && (
                  <div className="absolute left-1/2 top-full z-10 mt-1.5 w-52 -translate-x-1/2 overflow-hidden rounded-xl border border-[var(--wb-border-strong)] bg-[var(--wb-elev)] py-1 text-left shadow-[var(--wb-float-shadow)]">
                    {(
                      [
                        ["create", "在此电脑上添加文件夹"],
                        ["import", "导入现有文件夹"],
                      ] as const
                    ).map(([mode, label]) => (
                      <button
                        key={mode}
                        type="button"
                        className={cn(
                          "block w-full px-3 py-2 text-left text-sm hover:bg-[var(--wb-hover)]",
                          source === mode ? "font-medium text-[var(--wb-text-strong)]" : "text-[var(--wb-muted)]",
                        )}
                        onClick={() => {
                          setSource(mode);
                          setSourceMenu(false);
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {dir ? (
                <p className="mt-2 w-full min-w-0 truncate text-xs text-[var(--wb-muted)]" title={dir}>
                  {dir}
                </p>
              ) : null}
              <div className="mt-3">
                <button
                  type="button"
                  onClick={() => void pickDir()}
                  className="inline-flex items-center gap-1.5 rounded-full border border-[var(--wb-border-strong)] bg-[var(--wb-chip)] px-3 py-1 text-xs font-medium text-[var(--wb-text-strong)] transition-colors hover:bg-[var(--wb-chip-hover)]"
                >
                  <FolderPlus className="h-3.5 w-3.5" />
                  添加
                </button>
              </div>
            </div>
            {source === "create" && name.trim() && dir.trim() ? (
              <p className="mt-1.5 min-w-0 truncate text-[11px] text-[var(--wb-muted)]">
                将创建：{dir.replace(/[\\/]+$/, "")}/{name.trim()}
              </p>
            ) : null}
          </div>

          {source === "create" && (
            <label className="flex cursor-pointer items-center gap-2 text-sm text-[var(--wb-muted)]">
              <input
                type="checkbox"
                checked={initGit}
                onChange={(e) => setInitGit(e.target.checked)}
                className="h-4 w-4 rounded border-[var(--wb-border-strong)] bg-[var(--wb-well)] accent-[var(--wb-accent)]"
              />
              初始化 Git 仓库（git init）
            </label>
          )}

          {lastError && (
            <p className="rounded-lg border border-[var(--wb-danger-border)] bg-[var(--wb-danger-bg)] px-3 py-2 text-xs text-[var(--wb-danger-text)]">
              {lastError}
            </p>
          )}

          <div className="flex min-w-0 items-center justify-end gap-2.5 pt-1">
            <Button type="button" variant="ghost" onClick={closeDialog}>
              取消
            </Button>
            <Button type="submit" disabled={!valid || busy}>
              {busy ? "处理中…" : source === "import" ? "导入项目" : "创建项目"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
