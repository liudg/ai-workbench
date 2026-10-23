// 与 crates/aiwb-core/src/project.rs 一致。

export interface Project {
  id: string;
  name: string;
  path: string;
  folders: string[];
  defaultAgent: string;
  createdAt: number;
  updatedAt: number;
}
