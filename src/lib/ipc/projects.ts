import type { Project } from "@/types";
import { invoke } from "./call";
import type { Backend } from "./contract";
import type { CreateProjectResult } from "./dto";

export const projectCommands: Pick<
  Backend,
  "listProjects" | "createProject" | "importProject" | "removeProject" | "projectIsGit"
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
  projectIsGit: (projectId) => invoke<boolean>("project_is_git", { projectId }),
};
