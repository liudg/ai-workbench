import { useWorkbench } from "@/store";

export function useSessionProjectPath(projectId: string): string {
  return useWorkbench(
    (state) => state.projects.find((project) => project.id === projectId)?.path ?? "",
  );
}
