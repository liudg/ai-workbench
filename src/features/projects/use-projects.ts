import { TOPIC_PROJECTS, useTopic } from "@/lib/daemon";
import type { Project } from "./types";

/** 项目列表。还没收到第一份快照时 `loading` 为 true。 */
export function useProjects() {
  const projects = useTopic<Project[]>(TOPIC_PROJECTS);
  return { projects: projects ?? [], loading: projects === undefined };
}
