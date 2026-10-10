import { useEffect, useState } from "react";
import { FolderSearch } from "lucide-react";

import { backend } from "@/lib/ipc";
import { useWorkbench } from "@/store";
import { AGENT_LABELS, type AgentKind } from "@/types";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";

const AGENTS: AgentKind[] = ["codex-cli", "claude-code"];

function AgentSelect({
  value,
  onChange,
}: {
  value: AgentKind;
  onChange: (v: AgentKind) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {AGENTS.map((agent) => (
        <button
          key={agent}
          type="button"
          onClick={() => onChange(agent)}
          className={
            value === agent
              ? "rounded-lg border border-indigo-500/60 bg-indigo-500/10 px-3 py-2 text-sm text-indigo-300"
              : "rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-400 hover:border-zinc-600 hover:text-zinc-300"
          }
        >
          {AGENT_LABELS[agent]}
        </button>
      ))}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-zinc-400">
        {label}
      </span>
      {children}
    </label>
  );
}

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

  const [name, setName] = useState("");
  const [dir, setDir] = useState("");
  const [agent, setAgent] = useState<AgentKind>("codex-cli");
  const [initGit, setInitGit] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (dialog) {
      setName("");
      setDir("");
      setAgent("codex-cli");
      setInitGit(true);
      setBusy(false);
      clearError();
    }
  }, [dialog, clearError]);

  const pickDir = async () => {
    const selected = await backend.pickDirectory(
      dialog === "create" ? "选择项目存放位置" : "选择要导入的项目文件夹",
    );
    if (selected) {
      setDir(selected);
      if (dialog === "import") setName(basename(selected));
    }
  };

  const submit = async () => {
    setBusy(true);
    if (dialog === "create") {
      const warning = await createProject({
        name,
        parentDir: dir,
        defaultAgent: agent,
        initGit,
      });
      if (warning) useWorkbench.setState({ lastError: warning });
    } else if (dialog === "import") {
      await importProject({ path: dir, name, defaultAgent: agent });
    }
    setBusy(false);
  };

  const valid =
    dialog === "create" ? name.trim() && dir.trim() : dir.trim();

  return (
    <Dialog open={dialog !== null} onOpenChange={(open) => !open && closeDialog()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {dialog === "create" ? "新建项目" : "导入文件夹"}
          </DialogTitle>
          <DialogDescription>
            {dialog === "create"
              ? "在所选位置创建新目录，可选执行 git init。"
              : "把已有的本地目录加入工作台（不会移动文件）。"}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {dialog === "create" && (
            <Field label="项目名称">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-project"
                autoFocus
              />
            </Field>
          )}

          <Field label={dialog === "create" ? "存放位置" : "项目目录"}>
            <div className="flex gap-2">
              <Input
                value={dir}
                onChange={(e) => setDir(e.target.value)}
                placeholder={
                  dialog === "create" ? "选择父目录…" : "选择已有目录…"
                }
                className="flex-1"
              />
              <Button variant="outline" onClick={pickDir} type="button">
                <FolderSearch /> 浏览
              </Button>
            </div>
            {dialog === "create" && name.trim() && dir.trim() && (
              <p className="mt-1.5 truncate text-[11px] text-zinc-500">
                将创建：{dir.replace(/[\\/]+$/, "")}/{name.trim()}
              </p>
            )}
          </Field>

          {dialog === "import" && (
            <Field label="项目名称">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="默认为目录名"
              />
            </Field>
          )}

          <Field label="默认 Agent">
            <AgentSelect value={agent} onChange={setAgent} />
          </Field>

          {dialog === "create" && (
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
        </div>

        {lastError && (
          <p className="rounded-md border border-red-500/25 bg-red-500/[0.06] px-3 py-2 text-xs text-red-300">
            {lastError}
          </p>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={closeDialog}>
            取消
          </Button>
          <Button onClick={submit} disabled={!valid || busy}>
            {busy ? "处理中…" : dialog === "create" ? "创建项目" : "导入"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
