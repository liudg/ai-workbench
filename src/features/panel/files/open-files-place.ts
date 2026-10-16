/** 「打开文件」当前预览。记在这个标签的 payload 上，切走再回来还在。 */

export interface OpenFilesPlace {
  path: string;
  line: number | null;
}

/** 同一个会话换了项目才清掉预览。切到别的会话时，那边自己的路径还在。 */
export function clearOpenFilesOnScope(
  previous: { projectId: string; sessionId: string },
  next: { projectId: string; sessionId: string },
): boolean {
  return previous.sessionId === next.sessionId && previous.projectId !== next.projectId;
}

export function openFilesPlace(payload: unknown): OpenFilesPlace {
  if (!payload || typeof payload !== "object") return { path: "", line: null };
  const record = payload as { path?: unknown; line?: unknown };
  const path = typeof record.path === "string" ? record.path : "";
  const line = typeof record.line === "number" && Number.isInteger(record.line) && record.line >= 1 ? record.line : null;
  return { path, line };
}
