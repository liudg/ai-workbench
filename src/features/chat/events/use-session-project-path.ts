import { useWorkbench } from "@/store";
import type { Session } from "@/types";

/** 工具路径相对会话工作目录。工作树会话用检出目录，其它会话用项目目录。 */
export function useSessionProjectPath(session: Pick<Session, "project_id" | "workdir">): string {
  const projectPath = useWorkbench(
    (state) => state.projects.find((project) => project.id === session.project_id)?.path ?? "",
  );
  return session.workdir?.trim() || projectPath;
}
