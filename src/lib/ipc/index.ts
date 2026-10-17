// 后端接口。UI 层只依赖本文件导出的 `backend`；命令走 `transport`
// （桌面版是 Tauri IPC，网页预览是连着同一套 Rust 后端的 dev bridge）。

import { isTauri } from "../transport";
import { browserCommands } from "./browser";
import type { Backend } from "./contract";
import { eventCommands } from "./events";
import { pickCommands } from "./picks";
import { previewCommands } from "./preview";
import { chatCommands } from "./chats";
import { projectCommands } from "./projects";
import { sessionCommands } from "./sessions";

export type {
  BrowserFile,
  BrowserNotice,
  CreateProjectInput,
  CreateProjectResult,
  DiffScope,
  FileSearchHit,
  FileSearchResult,
  ImportProjectInput,
  UpdateProjectInput,
  PathFilter,
  PreviewDocument,
  PreviewImage,
  SessionRequest,
  TreeEntry,
} from "./dto";
export type { Backend, TaskFolder } from "./contract";
export { isTauri };

export const backend: Backend = {
  ...chatCommands,
  ...projectCommands,
  ...sessionCommands,
  ...previewCommands,
  ...browserCommands,
  ...pickCommands,
  ...eventCommands,
};
