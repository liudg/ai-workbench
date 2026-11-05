import { useState } from "react";
import { FileText } from "lucide-react";

import { baseName, relativeToProject } from "@/shared/path";
import { usePanel } from "../core/PanelProvider";
import { payloadTitle, type PanelViewer, type ViewerViewProps } from "../core/registry";
import { FileContent } from "./FileContent";
import {
  markdownModeButtonLabel,
  markdownViewMode,
  nextMarkdownViewMode,
  rememberMarkdownViewMode,
  type MarkdownViewMode,
} from "./markdown-mode";
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
  const panel = usePanel();
  const path = payload.path ?? "";
  const [modeState, setModeState] = useState<{ path: string; mode: MarkdownViewMode }>(() => ({
    path,
    mode: markdownViewMode(path),
  }));
  if (modeState.path !== path) {
    setModeState({ path, mode: markdownViewMode(path) });
  }
  const shown = modeState.path === path ? modeState.mode : markdownViewMode(path);
  const toggle = () => {
    const next = nextMarkdownViewMode(shown);
    rememberMarkdownViewMode(path, next);
    setModeState({ path, mode: next });
  };
  let body = (
    <FileContent
      view={shown === "source" ? "source" : "markdown"}
      text={payload.text ?? ""}
      truncated={Boolean(payload.truncated)}
      quotePath={path}
      copyPath={relativeToProject(path, panel.projectPath)}
      commentable={false}
      markdown={{ label: markdownModeButtonLabel(shown), onToggle: toggle }}
      onAdd={(draft) => panel.data.addTextSnippet(sessionId, draft)}
    />
  );
  if (status === "loading") body = <PreviewPending />;
  else if (status === "error") body = <PreviewFailed message={payload.error ?? ""} />;
  const title = payloadTitle(payload) || baseName(path);
  return (
    <div data-open-files-preview data-markdown-view={shown} className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-[#222] px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[#bdbdbd]" title={path || title}>
          {title}
        </span>
        <button
          type="button"
          data-markdown-mode-toggle
          className="inline-flex h-7 shrink-0 items-center rounded-full border border-[#3a3a3a] bg-[#2a2a2a] px-3 text-[12px] leading-5 text-[#f3f3f3] hover:bg-[#333]"
          onClick={toggle}
        >
          {markdownModeButtonLabel(shown)}
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
