import { backend } from "@/lib/ipc";
import { BinaryFileError, ReopenAs, type ViewerContext } from "../core/registry";

export async function readProjectText(projectId: string, path: string) {
  const doc = await backend.readPreviewFile(projectId, path);
  if (doc.kind === "binary") throw new BinaryFileError();
  return doc;
}

export async function readPreviewDocument(ctx: ViewerContext, path: string) {
  return readProjectText(ctx.projectId, path);
}

export function reopenIfDifferent(actual: string, viewerId: string, path: string, line: number | null) {
  if (line != null) return;
  const kind = actual === "html" || actual === "markdown" || actual === "text" ? actual : "text";
  if (kind !== viewerId) {
    throw new ReopenAs({ kind: "file", path, line, viewerId: kind });
  }
}
