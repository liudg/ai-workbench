import { FileText } from "lucide-react";

import { baseName } from "../files/path";
import { payloadTitle, type PanelViewer, type ViewerViewProps } from "../core/registry";
import { MarkdownPreview } from "./MarkdownPreview";
import { readPreviewDocument, reopenIfDifferent } from "./document";
import { PreviewFailed, PreviewPending } from "./frame";
import { matchMarkdown } from "./kinds";

interface MarkdownPayload {
  title?: string;
  text?: string;
  truncated?: boolean;
  error?: string;
}

function MarkdownViewerBody({ payload, status }: ViewerViewProps<MarkdownPayload>) {
  if (status === "loading") return <PreviewPending />;
  if (status === "error") return <PreviewFailed message={payload.error ?? ""} />;
  return <MarkdownPreview text={payload.text ?? ""} truncated={Boolean(payload.truncated)} />;
}

export const markdownViewer: PanelViewer<MarkdownPayload> = {
  id: "markdown",
  match: matchMarkdown,
  icon: FileText,
  title: (payload) => payloadTitle(payload) || "Markdown",
  async load(target, ctx) {
    if (target.kind !== "file") return { title: "Markdown", text: "", truncated: false };
    const doc = await readPreviewDocument(ctx, target.path);
    reopenIfDifferent(doc.kind, "markdown", target.path, target.line);
    return {
      title: baseName(target.path),
      text: doc.text,
      truncated: doc.truncated,
    };
  },
  View: MarkdownViewerBody,
};
