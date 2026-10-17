// 预览、目录和建项这些命令的数据形状。会话协议类型在 `@/types`。

import type { AgentKind, Project } from "@/types";

export interface CreateProjectInput {
  name: string;
  parentDir: string;
  defaultAgent: AgentKind;
  initGit: boolean;
}

export interface CreateProjectResult {
  project: Project;
  warning: string | null;
}

/** 本地分支菜单。`dirty_files` 数不清时为 null，不拿 0 充数。 */
export interface GitBranchMenu {
  current: string | null;
  branches: string[];
  dirty_files: number | null;
}

export interface ImportProjectInput {
  path: string;
  name?: string;
  defaultAgent: AgentKind;
}

export interface TreeEntry {
  name: string;
  path: string;
  kind: "dir" | "file" | string;
}

export interface PathFilter {
  paths: string[];
  truncated: boolean;
  cancelled: boolean;
  /** 索引还在建时为 false。缺省当成已经完成，避免旧后端把轮询卡住。 */
  ready?: boolean;
}

export interface FileSearchHit {
  path: string;
  line: number | null;
  text: string;
  kind: "content" | "name" | string;
}

export interface FileSearchResult {
  hits: FileSearchHit[];
  truncated: boolean;
  done: boolean;
  cancelled: boolean;
}

export interface PreviewDocument {
  path: string;
  name: string;
  kind: string;
  text: string;
  truncated: boolean;
}

export interface PreviewImage {
  path: string;
  name: string;
  mime: string;
  data_base64: string;
}

export interface BrowserFile {
  display: string;
  url: string;
}

export interface DiffScope {
  id: string;
  label: string;
  /** `git` 或 `turn`。 */
  source: string;
}

export interface SessionRequest {
  session_id: string;
  project_id: string;
  agent: AgentKind;
  name: string | null;
  text: string | null;
}

export interface BrowserNotice {
  kind: string;
  value: string;
}
