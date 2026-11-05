import { Code } from "lucide-react";

import { baseName, relativeToProject } from "@/shared/path";
import { usePanelOptional } from "../core/PanelProvider";
import { payloadTitle, type PanelViewer, type ViewerViewProps } from "../core/registry";
import { FileContent } from "./FileContent";
import { SourceView } from "./SourceView";
import { readPreviewDocument, reopenIfDifferent } from "./document";
import { PreviewFailed, PreviewPending } from "./frame";
import { matchText } from "./kinds";

interface TextPayload {
  title?: string;
  path?: string;
  text?: string;
  truncated?: boolean;
  line?: number | null;
  error?: string;
}

function TextViewerBody({ payload, status }: ViewerViewProps<TextPayload>) {
  const panel = usePanelOptional();
  const path = payload.path ?? "";
  let body = <SourceView text={payload.text ?? ""} truncated={Boolean(payload.truncated)} />;
  if (status === "loading") body = <PreviewPending />;
  else if (status === "error") body = <PreviewFailed message={payload.error ?? ""} />;
  else if (path && panel) {
    body = (
      <FileContent
        view="source"
        text={payload.text ?? ""}
        line={payload.line ?? null}
        truncated={Boolean(payload.truncated)}
        quotePath={path}
        copyPath={relativeToProject(path, panel.projectPath)}
        commentable
        onAdd={(draft) => panel.data.addTextSnippet(panel.sessionId, draft)}
      />
    );
  }
  return (
    <div data-open-files-preview className="h-full min-h-0">
      {body}
    </div>
  );
}

export const textViewer: PanelViewer<TextPayload> = {
  id: "text",
  match: matchText,
  icon: Code,
  title: (payload) => payloadTitle(payload) || baseName(payload.path || "") || "文件",
  async load(target, ctx) {
    if (target.kind !== "file") return { title: "文件", text: "", truncated: false, line: null };
    const doc = await readPreviewDocument(ctx, target.path);
    reopenIfDifferent(doc.kind, "text", target.path, target.line);
    return {
      title: baseName(target.path),
      path: target.path,
      text: doc.text,
      truncated: doc.truncated,
      line: target.line,
    };
  },
  View: TextViewerBody,
};
