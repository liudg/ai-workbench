import { useCallback, useEffect, useRef, useState } from "react";

import { projectsApi } from "@/features/projects";
import { pickFolder } from "@/lib/native/pick-folder";
import { userFacingMessage } from "@/lib/user-facing";
import { showError } from "@/shared/shell/error-banner";
import { closeProjectDialog, openNewSession, useNavigation } from "@/shared/shell/navigation";

function basename(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? "";
}

/** 新建/导入项目的表单。目录选择和提交都走这里，对话框只渲染。 */
export function useNewProjectForm() {
  const dialog = useNavigation((state) => state.projectDialog);

  const [name, setName] = useState("");
  const [dir, setDir] = useState("");
  const [source, setSource] = useState<"create" | "import">("create");
  const [sourceMenu, setSourceMenu] = useState(false);
  const [initGit, setInitGit] = useState(true);
  const [busy, setBusy] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
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
      setLastError(null);
    }
  }, [dialog]);

  const pickDir = async () => {
    const selected = await pickFolder(source === "create" ? "选择项目存放位置" : "选择要导入的项目文件夹");
    if (!selected) return;
    setDir(selected);
    if (source === "import" && !name.trim()) setName(basename(selected));
  };

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setLastError(null);
    try {
      if (source === "create") {
        const created = await projectsApi.createProject({ name: name.trim(), parentDir: dir, initGit });
        // git init 没成功不挡建项目，提示一下。
        if (created.warning) showError(created.warning);
        openNewSession(created.project.id);
      } else {
        const project = await projectsApi.importProject({ path: dir, name: name.trim() || undefined });
        openNewSession(project.id);
      }
      closeProjectDialog();
    } catch (error) {
      setLastError(userFacingMessage(error) ?? "无法创建项目");
    } finally {
      setBusy(false);
    }
  };

  const valid = source === "create" ? Boolean(name.trim() && dir.trim()) : Boolean(dir.trim());
  const sourceLabel = source === "create" ? "在此电脑上添加文件夹" : "导入现有文件夹";

  return {
    dialog,
    closeDialog: closeProjectDialog,
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
