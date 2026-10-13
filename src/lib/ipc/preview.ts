import { invoke } from "./call";
import type { Backend } from "./contract";
import type { FileSearchResult, PathFilter, PreviewDocument, TreeEntry } from "./dto";

export const previewCommands: Pick<
  Backend,
  | "readPreviewFile"
  | "listProjectDir"
  | "filterProjectPaths"
  | "searchProjectFiles"
  | "openProjectFile"
> = {
  readPreviewFile: (projectId, path) =>
    invoke<PreviewDocument>("read_preview_file", { projectId, path }),
  listProjectDir: (projectId, path) =>
    invoke<TreeEntry[]>("list_project_dir", { projectId, path }),
  filterProjectPaths: (projectId, query) =>
    invoke<PathFilter>("filter_project_paths", { projectId, query }),
  searchProjectFiles: (projectId, query, mask, searchId) =>
    invoke<FileSearchResult>("search_project_files", { projectId, query, mask, searchId }),
  openProjectFile: (projectId, path) =>
    invoke("open_project_file", { projectId, path }),
};
