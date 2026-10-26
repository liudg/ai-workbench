import type { Session } from "@/types";
import { useChatHost } from "../host";

/** 工具路径相对会话工作目录。工作树会话用检出目录，其它会话用项目目录。 */
export function useSessionProjectPath(session: Pick<Session, "workdir">): string {
  const projectPath = useChatHost().projectPath;
  return session.workdir?.trim() || projectPath;
}
