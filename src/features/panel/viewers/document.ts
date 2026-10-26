import { BinaryFileError, ReopenAs, type ViewerContext } from "../core/registry";
import type { PanelData } from "../core/PanelProvider";

export async function readProjectText(data: PanelData, projectId: string, path: string, sessionId?: string) {
  const doc = await data.readPreviewFile(projectId, path, sessionId ?? "");
  if (doc.kind === "image") {
    throw new ReopenAs({ kind: "file", path, line: null, viewerId: "image" });
  }
  if (doc.kind === "binary") throw new BinaryFileError();
  return doc;
}

export async function readPreviewDocument(ctx: ViewerContext, path: string) {
  if (!ctx.data) throw new Error("无法读取文件");
  return readProjectText(ctx.data, ctx.projectId, path, ctx.sessionId);
}

export function reopenIfDifferent(actual: string, viewerId: string, path: string, line: number | null) {
  if (actual === "image") {
    if (viewerId !== "image") {
      throw new ReopenAs({ kind: "file", path, line: null, viewerId: "image" });
    }
    return;
  }
  if (line != null) return;
  const kind = actual === "html" || actual === "markdown" || actual === "text" ? actual : "text";
  if (kind !== viewerId) {
    throw new ReopenAs({ kind: "file", path, line, viewerId: kind });
  }
}
