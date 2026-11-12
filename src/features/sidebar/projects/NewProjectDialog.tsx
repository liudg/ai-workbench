import { Folder, FolderOpen } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useNewProjectForm } from "./useNewProjectForm";

export function NewProjectDialog() {
  const {
    dialog,
    closeDialog,
    lastError,
    name,
    setName,
    dir,
    placeholder,
    source,
    setSource,
    initGit,
    setInitGit,
    busy,
    pickDir,
    submit,
    valid,
  } = useNewProjectForm();

  return (
    <Dialog open={dialog !== null} onOpenChange={(open) => !open && closeDialog()}>
      <DialogContent className="max-w-[440px] gap-4 [&>*]:min-w-0">
        <DialogHeader className="pr-6">
          <DialogTitle>{source === "import" ? "导入项目目录" : "新建项目"}</DialogTitle>
          <DialogDescription>
            {source === "import" ? "选择本地已有代码目录接入工作台。" : "在指定位置创建新目录并可选初始化 Git。"}
          </DialogDescription>
        </DialogHeader>

        <div
          role="tablist"
          aria-label="添加方式"
          className="grid grid-cols-2 gap-1 rounded-lg border border-wb-border bg-wb-elev p-1"
        >
          {(
            [
              ["import", "导入现有目录"],
              ["create", "新建空目录"],
            ] as const
          ).map(([mode, label]) => {
            const active = source === mode;
            return (
              <button
                key={mode}
                id={`new-project-tab-${mode}`}
                type="button"
                role="tab"
                aria-selected={active}
                aria-controls={`new-project-panel-${mode}`}
                tabIndex={active ? 0 : -1}
                onClick={() => setSource(mode)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                    event.preventDefault();
                    const next = mode === "import" ? "create" : "import";
                    setSource(next);
                    document.getElementById(`new-project-tab-${next}`)?.focus();
                  }
                }}
                className={cn(
                  "rounded-md py-1.5 text-xs font-medium transition-colors",
                  active
                    ? "bg-wb-popover text-wb-fg shadow-xs"
                    : "text-wb-fg-2 hover:text-wb-fg",
                )}
              >
                {label}
              </button>
            );
          })}
        </div>

        <form
          id={`new-project-panel-${source}`}
          role="tabpanel"
          aria-labelledby={`new-project-tab-${source}`}
          className="min-w-0 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-wb-fg-2">
              {source === "import" ? "本地目录" : "存放位置"}
            </label>
            <div className="flex min-w-0 items-center gap-2">
              <div
                className={cn(
                  "flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg border border-wb-border-strong bg-wb-input px-3 text-sm",
                  dir ? "text-wb-fg" : "text-wb-dim",
                )}
                title={dir || undefined}
              >
                <Folder className="h-4 w-4 shrink-0 text-wb-fg-3" />
                <span className="min-w-0 flex-1 truncate">
                  {dir || (source === "import" ? "未选择目录" : "未选择父目录")}
                </span>
              </div>
              <Button type="button" variant="secondary" onClick={() => void pickDir()}>
                <FolderOpen className="h-3.5 w-3.5" />
                浏览
              </Button>
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-wb-fg-2">
              {source === "import" ? "显示名称（选填）" : "项目名称"}
            </label>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={placeholder}
              autoFocus={source === "create"}
            />
            {source === "create" && name.trim() && dir.trim() ? (
              <p className="min-w-0 truncate font-mono text-[11px] text-wb-fg-3">
                {dir.replace(/[\\/]+$/, "")}/{name.trim()}
              </p>
            ) : null}
          </div>

          {source === "create" && (
            <label className="flex cursor-pointer items-center gap-2 text-[13px] text-wb-fg-2">
              <input
                type="checkbox"
                checked={initGit}
                onChange={(event) => setInitGit(event.target.checked)}
                className="h-4 w-4 rounded border-wb-border-strong bg-wb-input accent-wb-accent"
              />
              初始化 Git 仓库
            </label>
          )}

          {lastError && (
            <p className="rounded-lg border border-wb-danger/25 bg-wb-danger-soft px-3 py-2 text-xs text-wb-danger">
              {lastError}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={closeDialog}>
              取消
            </Button>
            <Button type="submit" disabled={!valid || busy}>
              {busy ? "处理中…" : source === "import" ? "导入项目" : "创建项目"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
