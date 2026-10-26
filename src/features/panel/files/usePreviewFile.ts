import { useEffect, useState } from "react";

import { usePanelData, usePanelOptional } from "../core/PanelProvider";
import { BinaryFileError, ReopenAs } from "../core/registry";
import { readProjectText } from "../viewers/document";

export type PreviewFileState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; text: string; kind: string; truncated: boolean };

export function usePreviewFile(projectId: string, path: string): PreviewFileState {
  const sessionId = usePanelOptional()?.sessionId;
  const data = usePanelData();
  const [state, setState] = useState<PreviewFileState>({ status: "loading" });

  useEffect(() => {
    if (!path) return;
    let cancel = false;
    setState({ status: "loading" });
    void readProjectText(data, projectId, path, sessionId).then(
      (doc) => {
        if (cancel) return;
        setState({
          status: "ready",
          text: doc.text,
          kind: doc.kind,
          truncated: doc.truncated,
        });
      },
      (err: unknown) => {
        if (cancel) return;
        if (err instanceof ReopenAs && err.target.kind === "file" && err.target.viewerId === "image") {
          setState({ status: "ready", text: "", kind: "image", truncated: false });
          return;
        }
        if (err instanceof BinaryFileError) {
          setState({ status: "ready", text: "", kind: "binary", truncated: false });
          return;
        }
        setState({ status: "error", message: errorText(err) });
      },
    );
    return () => {
      cancel = true;
    };
  }, [data, path, projectId, sessionId]);

  return state;
}

function errorText(err: unknown): string {
  if (typeof err === "string" && err.trim()) return err;
  if (err instanceof Error && err.message.trim()) return err.message;
  return "无法读取文件";
}
