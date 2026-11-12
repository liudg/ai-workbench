export type ProjectSourceMode = "import" | "create";

export interface NewProjectFormState {
  source: ProjectSourceMode;
  importDir: string;
  importName: string;
  createDir: string;
  createName: string;
  initGit: boolean;
  lastError: string | null;
}

function folderBasename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? "";
}

export function initialNewProjectForm(source: ProjectSourceMode = "import"): NewProjectFormState {
  return {
    source,
    importDir: "",
    importName: "",
    createDir: "",
    createName: "",
    initGit: true,
    lastError: null,
  };
}

export function selectProjectSource(
  state: NewProjectFormState,
  source: ProjectSourceMode,
): NewProjectFormState {
  if (state.source === source && state.lastError === null) return state;
  return {
    ...state,
    source,
    lastError: null,
  };
}

export function applyPickedFolder(state: NewProjectFormState, selected: string): NewProjectFormState {
  if (!selected) return state;
  if (state.source === "import") {
    return {
      ...state,
      importDir: selected,
      lastError: null,
    };
  }
  return {
    ...state,
    createDir: selected,
    lastError: null,
  };
}

export function updateProjectName(state: NewProjectFormState, value: string): NewProjectFormState {
  if (state.source === "import") {
    return { ...state, importName: value };
  }
  return { ...state, createName: value };
}

export function activeNewProjectFields(state: NewProjectFormState) {
  if (state.source === "import") {
    const base = folderBasename(state.importDir);
    return {
      dir: state.importDir,
      name: state.importName,
      placeholder: base ? `默认使用 ${base}` : "默认使用目录名",
      valid: Boolean(state.importDir.trim()),
    };
  }
  return {
    dir: state.createDir,
    name: state.createName,
    placeholder: "例如 my-service",
    valid: Boolean(state.createDir.trim() && state.createName.trim()),
  };
}
