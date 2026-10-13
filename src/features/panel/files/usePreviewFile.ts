import { useEffect, useState } from "react";

import { readProjectText } from "../viewers/document";

export type PreviewFileState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; text: string; kind: string; truncated: boolean };

export function usePreviewFile(projectId: string, path: string): PreviewFileState {
  const [state, setState] = useState<PreviewFileState>({ status: "loading" });

  useEffect(() => {
    if (!path) return;
    let cancel = false;
    setState({ status: "loading" });
    void readProjectText(projectId, path).then(
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
        setState({ status: "error", message: errorText(err) });
      },
    );
    return () => {
      cancel = true;
    };
  }, [path, projectId]);

  return state;
}

function errorText(err: unknown): string {
  if (typeof err === "string" && err.trim()) return err;
  if (err instanceof Error && err.message.trim()) return err.message;
  return "无法读取文件";
}
