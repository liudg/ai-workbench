import { FileText } from "lucide-react";

import { baseName, relativeToProject } from "@/shared/path";
import { usePanel } from "../core/PanelProvider";
import { payloadTitle, type PanelViewer, type ViewerViewProps } from "../core/registry";
import { FileContent } from "./FileContent";
import { markdownModeButtonLabel } from "./markdown-mode";
import { readPreviewDocument, reopenIfDifferent } from "./document";
import { PreviewFailed, PreviewPending } from "./frame";
import { matchMarkdown } from "./kinds";
import { useMarkdownPreviewMode } from "./use-markdown-preview-mode";

interface MarkdownPayload {
  title?: string;
  path?: string;
  line?: number | null;
  text?: string;
  truncated?: boolean;
  error?: string;
}

function MarkdownViewerBody({ payload, status, sessionId }: ViewerViewProps<MarkdownPayload>) {
  const panel = usePanel();
  const path = payload.path ?? "";
  const line = payload.line ?? null;
  const md = useMarkdownPreviewMode(path, line, true);
  const shown = md.mode ?? "preview";
  const toggleLabel = md.label ?? markdownModeButtonLabel(shown);
  let body = (
    <FileContent
      view={shown === "source" ? "source" : "markdown"}
      text={payload.text ?? ""}
      truncated={Boolean(payload.truncated)}
      line={shown === "source" ? line : null}
      quotePath={path}
      copyPath={relativeToProject(path, panel.projectPath)}
      commentable={false}
      markdown={{ label: toggleLabel, onToggle: md.toggle }}
      onAdd={(draft) => panel.data.addTextSnippet(sessionId, draft)}
    />
  );
  if (status === "loading") body = <PreviewPending />;
  else if (status === "error") body = <PreviewFailed message={payload.error ?? ""} />;
  const title = payloadTitle(payload) || baseName(path);
  return (
    <div data-open-files-preview data-markdown-view={shown} className="flex h-full min-h-0 flex-col bg-wb-panel">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-wb-border bg-wb-panel px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-wb-fg-2" title={path || title}>
          {title}
        </span>
        <button
          type="button"
          data-markdown-mode-toggle
          className="inline-flex h-7 shrink-0 items-center rounded-lg border border-wb-border bg-wb-elev px-2.5 text-[12px] leading-5 text-wb-fg transition-colors hover:border-wb-border-strong hover:bg-wb-hover"
          onClick={md.toggle}
        >
          {toggleLabel}
        </button>
      </div>
      <div className="min-h-0 flex-1">{body}</div>
    </div>
  );
}

export const markdownViewer: PanelViewer<MarkdownPayload> = {
  id: "markdown",
  match: matchMarkdown,
  icon: FileText,
  title: (payload) => payloadTitle(payload) || "Markdown",
  async load(target, ctx) {
    if (target.kind !== "file") return { title: "Markdown", path: "", line: null, text: "", truncated: false };
    const doc = await readPreviewDocument(ctx, target.path);
    reopenIfDifferent(doc.kind, "markdown", target.path, target.line);
    return {
      title: baseName(target.path),
      path: target.path,
      line: target.line ?? null,
      text: doc.text,
      truncated: doc.truncated,
    };
  },
  View: MarkdownViewerBody,
};
