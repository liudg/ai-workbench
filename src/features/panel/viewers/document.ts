import { backend } from "@/lib/ipc";
import { BinaryFileError, ReopenAs, type ViewerContext } from "../core/registry";

export async function readPreviewDocument(ctx: ViewerContext, path: string) {
  const doc = await backend.readPreviewFile(ctx.projectId, path);
  if (doc.kind === "binary") throw new BinaryFileError();
  return doc;
}

export function reopenIfDifferent(actual: string, viewerId: string, path: string, line: number | null) {
  if (line != null) return;
  const kind = actual === "html" || actual === "markdown" || actual === "text" ? actual : "text";
  if (kind !== viewerId) {
    throw new ReopenAs({ kind: "file", path, line, viewerId: kind });
  }
}
