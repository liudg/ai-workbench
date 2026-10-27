import { projectsApi } from "@/features/projects";
import { daemon } from "@/lib/daemon";
import type { Project } from "@/features/projects";

/** 开发预览把本机目录登记成项目。已经在列表里就复用，不另造一条。 */
export async function projectIdForRoot(root: string, name: string): Promise<string> {
  const existing = await findProjectId(root);
  if (existing) return existing;
  try {
    const project = await projectsApi.importProject({ path: root, name });
    return project.id;
  } catch (err: unknown) {
    const again = await findProjectId(root);
    if (again) return again;
    throw err;
  }
}

async function findProjectId(root: string): Promise<string> {
  const projects = await daemon.call<Project[]>("projects.list");
  return projects.find((item) => samePath(item.path, root))?.id ?? "";
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return normalize(left) === normalize(right);
}
