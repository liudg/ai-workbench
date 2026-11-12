import { useEffect, useState } from "react";

import { projectsApi } from "@/features/projects";
import { pickFolder } from "@/lib/native/pick-folder";
import { userFacingMessage } from "@/lib/user-facing";
import { showError } from "@/shared/shell/error-banner";
import { closeProjectDialog, openNewSession, useNavigation } from "@/shared/shell/navigation";
import {
  activeNewProjectFields,
  applyPickedFolder,
  initialNewProjectForm,
  selectProjectSource,
  updateProjectName,
  type ProjectSourceMode,
} from "./new-project-form";

/** 新建/导入项目的表单。目录选择和提交都走这里，对话框只渲染。 */
export function useNewProjectForm() {
  const dialog = useNavigation((state) => state.projectDialog);

  const [form, setForm] = useState(() => initialNewProjectForm("import"));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (dialog) {
      setForm(initialNewProjectForm(dialog));
      setBusy(false);
    }
  }, [dialog]);

  const fields = activeNewProjectFields(form);

  const setSource = (mode: ProjectSourceMode) => {
    setForm((current) => selectProjectSource(current, mode));
  };

  const setName = (value: string) => {
    setForm((current) => updateProjectName(current, value));
  };

  const setInitGit = (initGit: boolean) => {
    setForm((current) => ({ ...current, initGit }));
  };

  const pickDir = async () => {
    const selected = await pickFolder(form.source === "create" ? "选择项目存放目录" : "选择要导入的项目目录");
    if (!selected) return;
    setForm((current) => applyPickedFolder(current, selected));
  };

  const submit = async () => {
    if (!fields.valid || busy) return;
    setBusy(true);
    setForm((current) => ({ ...current, lastError: null }));
    try {
      if (form.source === "create") {
        const created = await projectsApi.createProject({
          name: fields.name.trim(),
          parentDir: fields.dir,
          initGit: form.initGit,
        });
        if (created.warning) showError(created.warning);
        openNewSession(created.project.id);
      } else {
        const project = await projectsApi.importProject({
          path: fields.dir,
          name: fields.name.trim() || undefined,
        });
        openNewSession(project.id);
      }
      closeProjectDialog();
    } catch (error) {
      setForm((current) => ({ ...current, lastError: userFacingMessage(error) ?? "无法添加项目" }));
    } finally {
      setBusy(false);
    }
  };

  return {
    dialog,
    closeDialog: closeProjectDialog,
    lastError: form.lastError,
    name: fields.name,
    setName,
    dir: fields.dir,
    placeholder: fields.placeholder,
    source: form.source,
    setSource,
    initGit: form.initGit,
    setInitGit,
    busy,
    pickDir,
    submit,
    valid: fields.valid,
  };
}
