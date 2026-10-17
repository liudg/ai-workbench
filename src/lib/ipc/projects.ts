import type { Project } from "@/types";
import { invoke } from "./call";
import type { Backend } from "./contract";
import type { CreateProjectResult, GitBranchMenu } from "./dto";

export const projectCommands: Pick<
  Backend,
  | "listProjects"
  | "createProject"
  | "importProject"
  | "removeProject"
  | "openProjectFolder"
  | "projectIsGit"
  | "projectBranch"
  | "projectGitBranches"
  | "projectCheckoutBranch"
  | "projectCreateBranch"
> = {
  listProjects: () => invoke<Project[]>("list_projects"),
  createProject: (input) =>
    invoke<CreateProjectResult>("create_project", {
      name: input.name,
      parentDir: input.parentDir,
      defaultAgent: input.defaultAgent,
      initGit: input.initGit,
    }),
  importProject: (input) =>
    invoke<Project>("import_project", {
      path: input.path,
      name: input.name ?? null,
      defaultAgent: input.defaultAgent,
    }),
  removeProject: (id) => invoke("remove_project", { id }),
  openProjectFolder: (id) => invoke("open_project_folder", { id }),
  projectIsGit: (projectId) => invoke<boolean>("project_is_git", { projectId }),
  projectBranch: (projectId) => invoke<string | null>("project_branch", { projectId }),
  projectGitBranches: (projectId) => invoke<GitBranchMenu>("project_git_branches", { projectId }),
  projectCheckoutBranch: (projectId, name) => invoke("project_checkout_branch", { projectId, name }),
  projectCreateBranch: (projectId, name) => invoke("project_create_branch", { projectId, name }),
};
