import { useCallback, useState } from "react";

import { daemon, TOPIC_PROJECTS, useTopic } from "@/lib/daemon";
import { pickFolder } from "@/lib/native/pick-folder";
import type { Project } from "./types";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useProjects() {
  const projects = useTopic<Project[]>(TOPIC_PROJECTS);
  const [error, setError] = useState<string | null>(null);

  const addProject = useCallback(async (): Promise<Project | null> => {
    const path = await pickFolder("选择项目文件夹");
    if (!path) return null;
    try {
      setError(null);
      return await daemon.call<Project>("projects.add", { path });
    } catch (e) {
      setError(message(e));
      return null;
    }
  }, []);

  const removeProject = useCallback(async (id: string) => {
    try {
      setError(null);
      await daemon.call<boolean>("projects.remove", { id });
    } catch (e) {
      setError(message(e));
    }
  }, []);

  return {
    projects: projects ?? [],
    loading: projects === undefined,
    error,
    dismissError: () => setError(null),
    addProject,
    removeProject,
  };
}
