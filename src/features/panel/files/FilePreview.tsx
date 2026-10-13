import { useEffect, useState } from "react";

import { backend } from "@/lib/ipc";
import { MarkdownPreview } from "../viewers/MarkdownPreview";
import { SourceView } from "../viewers/SourceView";
import { TextPreview } from "../viewers/TextPreview";
import { PreviewFailed, PreviewPending } from "../viewers/frame";

type PreviewState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; text: string; kind: string; truncated: boolean };

/** 在当前「打开文件」页里预览。不新开标签。 */
export function FilePreview({
  projectId,
  path,
  line,
}: {
  projectId: string;
  path: string;
  line: number | null;
}) {
  const [state, setState] = useState<PreviewState>({ status: "loading" });

  useEffect(() => {
    let cancel = false;
    setState({ status: "loading" });
    void backend.readPreviewFile(projectId, path).then(
      (doc) => {
        if (cancel) return;
        if (doc.kind === "binary") {
          setState({ status: "error", message: "这个文件不能以文本预览。" });
          return;
        }
        setState({
          status: "ready",
          text: doc.text,
          kind: doc.kind,
          truncated: doc.truncated,
        });
      },
      (err: unknown) => {
        if (cancel) return;
        const message = typeof err === "string" && err.trim() ? err : "无法读取文件";
        setState({ status: "error", message });
      },
    );
    return () => {
      cancel = true;
    };
  }, [path, projectId]);

  return (
    <div
      data-open-files-preview
      data-preview-path={path}
      data-preview-line={line ?? ""}
      data-preview-status={state.status}
      className="flex h-full min-h-0 flex-col"
    >
      <div className="shrink-0 truncate border-b border-zinc-800 px-3 py-1.5 font-mono text-[11px] text-zinc-500">
        {path}
      </div>
      <div className="min-h-0 flex-1">
        {state.status === "loading" ? <PreviewPending /> : null}
        {state.status === "error" ? <PreviewFailed message={state.message} /> : null}
        {state.status === "ready" ? (
          <PreviewBody text={state.text} kind={state.kind} truncated={state.truncated} line={line} />
        ) : null}
      </div>
    </div>
  );
}

function PreviewBody({
  text,
  kind,
  truncated,
  line,
}: {
  text: string;
  kind: string;
  truncated: boolean;
  line: number | null;
}) {
  if (line != null) return <SourceView text={text} line={line} />;
  if (kind === "markdown") return <MarkdownPreview text={text} truncated={truncated} />;
  return <TextPreview text={text} truncated={truncated} />;
}
