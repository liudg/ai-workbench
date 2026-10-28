import { useState } from "react";

import { projectsApi, type Project } from "@/features/projects";
import { pickFolder } from "@/lib/native/pick-folder";
import { userFacingMessage } from "@/lib/user-facing";
import { leaveProject } from "@/shared/shell/navigation";
import { projectFolders, sameFolder } from "./project-folders";

/** 编辑项目的草稿。目录选择和保存走这里，对话框只渲染。 */
export function useEditProjectForm(project: Project, onClose: () => void) {
  const [name, setName] = useState(project.name);
  const [folders, setFolders] = useState(() => projectFolders(project));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const removeFolder = (index: number) => {
    setFolders((current) => current.filter((_, item) => item !== index));
  };

  const addFolder = async () => {
    if (busy) return;
    setError(null);
    try {
      const selected = await pickFolder("添加源文件夹");
      if (!selected) return;
      setFolders((current) =>
        current.some((item) => sameFolder(item, selected)) ? current : [...current, selected],
      );
    } catch (err) {
      setError(userFacingMessage(err) ?? "无法添加文件夹");
    }
  };

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await projectsApi.updateProject({ id: project.id, name: name.trim(), folders });
      onClose();
    } catch (err) {
      setError(userFacingMessage(err) ?? "无法保存项目");
      setBusy(false);
    }
  };

  const removeLocal = async () => {
    if (busy) return;
    if (!confirmingRemove) {
      setConfirmingRemove(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await projectsApi.removeProject(project.id);
      leaveProject(project.id);
      onClose();
    } catch (err) {
      setError(userFacingMessage(err) ?? "无法移除项目");
      setBusy(false);
    }
  };

  const valid = name.trim().length > 0 && folders.length > 0;

  return {
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
    onClose,
  };
}
