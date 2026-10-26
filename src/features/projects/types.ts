// 与 crates/aiwb-core/src/project.rs 一致。

export interface Project {
  id: string;
  name: string;
  /** 主目录，等于 `folders[0]`。 */
  path: string;
  folders: string[];
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CreateProjectInput {
  name: string;
  parentDir: string;
  initGit: boolean;
}

export interface ImportProjectInput {
  path: string;
  name?: string;
}

export interface UpdateProjectInput {
  id: string;
  name: string;
  folders: string[];
}

/** 分支操作的目录：会话的工作目录，或项目主目录。 */
export type GitScope = { sessionId: string } | { projectId: string };

/** 本地分支、当前检出和未提交文件数。与 crates/aiwb-git 的 `GitBranchMenu` 一致。 */
export interface GitBranchMenu {
  current: string | null;
  branches: string[];
  dirty_files: number | null;
}
