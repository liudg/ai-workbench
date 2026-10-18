import { invoke } from "./call";
import type { Backend } from "./contract";
import type { FileSearchResult, PathFilter, PreviewDocument, PreviewImage, TreeEntry } from "./dto";

export const previewCommands: Pick<
  Backend,
  | "readPreviewFile"
  | "readPreviewImage"
  | "listProjectDir"
  | "filterProjectPaths"
  | "quickOpenFiles"
  | "warmProjectIndex"
  | "searchProjectFiles"
  | "openProjectFile"
  | "fileOpenCapabilities"
> = {
  readPreviewFile: (projectId, path, sessionId) =>
    invoke<PreviewDocument>("read_preview_file", { projectId, path, sessionId: sessionId ?? null }),
  readPreviewImage: (projectId, path, sessionId) =>
    invoke<PreviewImage>("read_preview_image", { projectId, path, sessionId: sessionId ?? null }),
  listProjectDir: (projectId, path, sessionId) =>
    invoke<TreeEntry[]>("list_project_dir", { projectId, path, sessionId: sessionId ?? null }),
  filterProjectPaths: (projectId, query, sessionId) =>
    invoke<PathFilter>("filter_project_paths", { projectId, query, sessionId: sessionId ?? null }),
  quickOpenFiles: (projectId, query) =>
    invoke<PathFilter>("quick_open_files", { projectId, query }),
  warmProjectIndex: (projectId, sessionId) =>
    invoke("warm_project_index", { projectId, sessionId: sessionId ?? null }),
  searchProjectFiles: (projectId, query, mask, searchId, sessionId) =>
    invoke<FileSearchResult>("search_project_files", {
      projectId,
      query,
      mask,
      searchId,
      sessionId: sessionId ?? null,
    }),
  openProjectFile: (projectId, path, mode, sessionId) =>
    invoke("open_project_file", {
      projectId,
      path,
      mode: mode ?? "default",
      sessionId: sessionId ?? null,
    }),
  fileOpenCapabilities: () => invoke("file_open_capabilities"),
};
