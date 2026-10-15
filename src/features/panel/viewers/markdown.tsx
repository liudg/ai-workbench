import { useRef } from "react";
import { FileText } from "lucide-react";

import { baseName } from "@/shared/path";
import { addSessionTextSnippet } from "../core/useAddTextSnippet";
import { SelectionMenu } from "./SelectionMenu";
import { payloadTitle, type PanelViewer, type ViewerViewProps } from "../core/registry";
import { MarkdownPreview } from "./MarkdownPreview";
import { readPreviewDocument, reopenIfDifferent } from "./document";
import { PreviewFailed, PreviewPending } from "./frame";
import { matchMarkdown } from "./kinds";

interface MarkdownPayload {
  title?: string;
  path?: string;
  text?: string;
  truncated?: boolean;
  error?: string;
}

function MarkdownViewerBody({ payload, status, sessionId }: ViewerViewProps<MarkdownPayload>) {
  const rootRef = useRef<HTMLDivElement>(null);
  const path = payload.path ?? "";
  let body = <MarkdownPreview text={payload.text ?? ""} truncated={Boolean(payload.truncated)} />;
  if (status === "loading") body = <PreviewPending />;
  else if (status === "error") body = <PreviewFailed message={payload.error ?? ""} />;
  return (
    <div ref={rootRef} data-open-files-preview className="h-full min-h-0">
      {body}
      {status === "ready" && path ? (
        <SelectionMenu
          rootRef={rootRef}
          path={path}
          onAdd={(draft) => {
            addSessionTextSnippet(sessionId, draft);
          }}
        />
      ) : null}
    </div>
  );
}

export const markdownViewer: PanelViewer<MarkdownPayload> = {
  id: "markdown",
  match: matchMarkdown,
  icon: FileText,
  title: (payload) => payloadTitle(payload) || "Markdown",
  async load(target, ctx) {
    if (target.kind !== "file") return { title: "Markdown", path: "", text: "", truncated: false };
    const doc = await readPreviewDocument(ctx, target.path);
    reopenIfDifferent(doc.kind, "markdown", target.path, target.line);
    return {
      title: baseName(target.path),
      path: target.path,
      text: doc.text,
      truncated: doc.truncated,
    };
  },
  View: MarkdownViewerBody,
};
