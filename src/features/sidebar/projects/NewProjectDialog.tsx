import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, Folder, FolderPlus } from "lucide-react";

import { persistedAgentKind } from "@/lib/agents";
import { backend } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useWorkbench } from "@/store";
import { useDismiss } from "../use-dismiss";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

function basename(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? "";
}

export function NewProjectDialog() {
  const dialog = useWorkbench((s) => s.dialog);
  const closeDialog = useWorkbench((s) => s.closeDialog);
  const createProject = useWorkbench((s) => s.createProject);
  const importProject = useWorkbench((s) => s.importProject);
  const lastError = useWorkbench((s) => s.lastError);
  const clearError = useWorkbench((s) => s.clearError);
  const installations = useWorkbench((s) => s.installations);
  const preferredAgent = useWorkbench((s) => s.preferredAgent);

  const [name, setName] = useState("");
  const [dir, setDir] = useState("");
  const [source, setSource] = useState<"create" | "import">("create");
  const [sourceMenu, setSourceMenu] = useState(false);
  const [initGit, setInitGit] = useState(true);
  const [busy, setBusy] = useState(false);
  const sourceRef = useRef<HTMLDivElement>(null);
  const closeSourceMenu = useCallback(() => setSourceMenu(false), []);
  useDismiss(sourceMenu, sourceRef, closeSourceMenu);

  useEffect(() => {
    if (dialog) {
      setName("");
      setDir("");
      setSource(dialog);
      setSourceMenu(false);
      setInitGit(true);
      setBusy(false);
      clearError();
    }
  }, [dialog, clearError]);

  const pickDir = async () => {
    const selected = await backend.pickDirectory(
      source === "create" ? "选择项目存放位置" : "选择要导入的项目文件夹",
    );
    if (!selected) return;
    setDir(selected);
    if (source === "import" && !name.trim()) setName(basename(selected));
  };

  const submit = async () => {
    if (!valid || busy) return;
    const defaultAgent = persistedAgentKind(installations, preferredAgent);
    if (!defaultAgent) {
      useWorkbench.setState({
        lastError:
          installations === null
            ? "正在检测本地 Agent，请稍后再创建项目。"
            : "未检测到已安装的 Agent。",
      });
      return;
    }
    setBusy(true);
    if (source === "create") {
      const warning = await createProject({
        name,
        parentDir: dir,
        defaultAgent,
        initGit,
      });
      if (warning) useWorkbench.setState({ lastError: warning });
    } else {
      await importProject({
        path: dir,
        name: name.trim() || undefined,
        defaultAgent,
      });
    }
    setBusy(false);
  };

  const valid = source === "create" ? Boolean(name.trim() && dir.trim()) : Boolean(dir.trim());
  const sourceLabel =
    source === "create" ? "在此电脑上添加文件夹" : "导入现有文件夹";

  return (
    <Dialog open={dialog !== null} onOpenChange={(open) => !open && closeDialog()}>
      <DialogContent
        className="max-w-[440px] gap-5 rounded-2xl border-zinc-700/80 bg-zinc-900 p-6"
        onEscapeKeyDown={(event) => {
          if (sourceMenu) {
            event.preventDefault();
            setSourceMenu(false);
          }
        }}
      >
        <DialogHeader className="pr-6">
          <DialogTitle className="text-lg font-semibold tracking-tight text-zinc-50">
            创建项目
          </DialogTitle>
          <DialogDescription className="sr-only">
            填写项目名称，并在此电脑上添加源文件夹。
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="flex items-center gap-2.5 rounded-xl border border-zinc-600/90 bg-zinc-950/50 px-3 transition-colors focus-within:border-sky-500 focus-within:ring-1 focus-within:ring-sky-500/70">
            <Folder className="h-4 w-4 shrink-0 text-zinc-500" />
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="项目名称"
              autoFocus
              className="h-11 w-full bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
            />
          </div>

          <div>
            <div className="mb-2 text-sm text-zinc-300">源文件夹</div>
            <div className="rounded-xl border border-zinc-700/80 bg-zinc-950/35 px-4 py-7 text-center">
              <div ref={sourceRef} className="relative inline-flex">
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-sm text-zinc-200 hover:text-white"
                  aria-expanded={sourceMenu}
                  onClick={() => setSourceMenu((open) => !open)}
                >
                  {sourceLabel}
                  <ChevronDown className="h-3.5 w-3.5 text-zinc-500" />
                </button>
                {sourceMenu && (
                  <div className="absolute left-1/2 top-full z-10 mt-1.5 w-52 -translate-x-1/2 overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 py-1 text-left shadow-xl shadow-black/40">
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
                          "block w-full px-3 py-2 text-left text-sm hover:bg-zinc-800",
                          source === mode ? "text-zinc-50" : "text-zinc-400",
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
                <p className="mx-auto mt-2 max-w-full truncate text-xs text-zinc-500" title={dir}>
                  {dir}
                </p>
              ) : null}
              <div className="mt-3">
                <button
                  type="button"
                  onClick={() => void pickDir()}
                  className="inline-flex items-center gap-1.5 rounded-full border border-zinc-600 bg-zinc-800/90 px-3 py-1 text-xs font-medium text-zinc-100 transition-colors hover:bg-zinc-700"
                >
                  <FolderPlus className="h-3.5 w-3.5" />
                  添加
                </button>
              </div>
            </div>
            {source === "create" && name.trim() && dir.trim() ? (
              <p className="mt-1.5 truncate text-[11px] text-zinc-500">
                将创建：{dir.replace(/[\\/]+$/, "")}/{name.trim()}
              </p>
            ) : null}
          </div>

          {source === "create" && (
            <label className="flex cursor-pointer items-center gap-2 text-sm text-zinc-400">
              <input
                type="checkbox"
                checked={initGit}
                onChange={(e) => setInitGit(e.target.checked)}
                className="h-4 w-4 rounded border-zinc-600 bg-zinc-800 accent-indigo-500"
              />
              初始化 Git 仓库（git init）
            </label>
          )}

          {lastError && (
            <p className="rounded-md border border-red-500/25 bg-red-500/[0.06] px-3 py-2 text-xs text-red-300">
              {lastError}
            </p>
          )}

          <div className="flex items-center justify-end gap-3 pt-1">
            <Button
              type="button"
              variant="ghost"
              className="text-zinc-400 hover:bg-transparent hover:text-zinc-200"
              onClick={closeDialog}
            >
              取消
            </Button>
            <Button
              type="submit"
              disabled={!valid || busy}
              className="rounded-lg bg-zinc-100 px-4 text-zinc-950 shadow-none hover:bg-white"
            >
              {busy ? "处理中…" : "创建项目"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
