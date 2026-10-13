import { useCallback, useEffect, useRef, useState } from "react";

import { persistedAgentKind } from "@/lib/agents";
import { backend } from "@/lib/ipc";
import { useWorkbench } from "@/store";

function basename(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? "";
}

/** 新建/导入项目的表单。目录选择和提交都走这里，对话框只渲染。 */
export function useNewProjectForm() {
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
  const sourceLabel = source === "create" ? "在此电脑上添加文件夹" : "导入现有文件夹";

  return {
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
  };
}
