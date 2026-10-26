// 项目和分支的 daemon 调用。展示组件不直接碰连接。

import { daemon } from "@/lib/daemon";
import type {
  CreateProjectInput,
  GitBranchMenu,
  GitScope,
  ImportProjectInput,
  Project,
  UpdateProjectInput,
} from "./types";

export function createProject(input: CreateProjectInput) {
  return daemon.call<{ project: Project; warning?: string }>("projects.create", { ...input });
}

export function importProject(input: ImportProjectInput) {
  return daemon.call<Project>("projects.add", { ...input });
}

export function updateProject(input: UpdateProjectInput) {
  return daemon.call<Project>("projects.update", { ...input });
}

export function setProjectPinned(id: string, pinned: boolean) {
  return daemon.call<boolean>("projects.setPinned", { id, pinned });
}

export function removeProject(id: string) {
  return daemon.call<boolean>("projects.remove", { id });
}

export function isGitRepo(scope: GitScope) {
  return daemon.call<boolean>("git.isRepo", { ...scope });
}

export function hasCommit(scope: GitScope) {
  return daemon.call<boolean>("git.hasCommit", { ...scope });
}

export function currentBranch(scope: GitScope) {
  return daemon.call<string | null>("git.branch", { ...scope });
}

export function branchMenu(scope: GitScope) {
  return daemon.call<GitBranchMenu>("git.branches", { ...scope });
}

export function checkoutBranch(scope: GitScope, name: string) {
  return daemon.call<null>("git.checkout", { ...scope, name });
}

export function createBranch(scope: GitScope, name: string) {
  return daemon.call<null>("git.createBranch", { ...scope, name });
}
