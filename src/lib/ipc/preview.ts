import { invoke } from "./call";
import type { Backend } from "./contract";
import type { FileSearchResult, PathFilter, PreviewDocument, PreviewImage, TreeEntry } from "./dto";

export const previewCommands: Pick<
  Backend,
  | "readPreviewFile"
  | "readPreviewImage"
  | "listProjectDir"
  | "filterProjectPaths"
  | "warmProjectIndex"
  | "searchProjectFiles"
  | "openProjectFile"
> = {
  readPreviewFile: (projectId, path) =>
    invoke<PreviewDocument>("read_preview_file", { projectId, path }),
  readPreviewImage: (projectId, path) =>
    invoke<PreviewImage>("read_preview_image", { projectId, path }),
  listProjectDir: (projectId, path) =>
    invoke<TreeEntry[]>("list_project_dir", { projectId, path }),
  filterProjectPaths: (projectId, query) =>
    invoke<PathFilter>("filter_project_paths", { projectId, query }),
  warmProjectIndex: (projectId) => invoke("warm_project_index", { projectId }),
  searchProjectFiles: (projectId, query, mask, searchId) =>
    invoke<FileSearchResult>("search_project_files", { projectId, query, mask, searchId }),
  openProjectFile: (projectId, path) =>
    invoke("open_project_file", { projectId, path }),
};
