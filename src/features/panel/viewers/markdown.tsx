import { useRef, useState } from "react";
import { FileText } from "lucide-react";

import { baseName } from "@/shared/path";
import { addSessionTextSnippet } from "../core/useAddTextSnippet";
import { SelectionMenu } from "@/shared/selection/SelectionMenu";
import { fileSelectionDraft } from "./file-selection";
import { payloadTitle, type PanelViewer, type ViewerViewProps } from "../core/registry";
import { MarkdownPreview } from "./MarkdownPreview";
import {
  markdownModeButtonLabel,
  markdownViewMode,
  nextMarkdownViewMode,
  rememberMarkdownViewMode,
  type MarkdownViewMode,
} from "./markdown-mode";
import { readPreviewDocument, reopenIfDifferent } from "./document";
import { PreviewFailed, PreviewPending } from "./frame";
import { TextPreview } from "./TextPreview";
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
  const [modeState, setModeState] = useState<{ path: string; mode: MarkdownViewMode }>(() => ({
    path,
    mode: markdownViewMode(path),
  }));
  if (modeState.path !== path) {
    setModeState({ path, mode: markdownViewMode(path) });
  }
  const shown = modeState.path === path ? modeState.mode : markdownViewMode(path);
  let body =
    shown === "source" ? (
      <TextPreview text={payload.text ?? ""} truncated={Boolean(payload.truncated)} />
    ) : (
      <MarkdownPreview text={payload.text ?? ""} truncated={Boolean(payload.truncated)} />
    );
  if (status === "loading") body = <PreviewPending />;
  else if (status === "error") body = <PreviewFailed message={payload.error ?? ""} />;
  const title = payloadTitle(payload) || baseName(path);
  return (
    <div data-open-files-preview data-markdown-view={shown} className="flex h-full min-h-0 flex-col bg-[var(--wb-canvas)]">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--wb-border)] bg-[var(--wb-canvas)] px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[var(--wb-muted)]" title={path || title}>
          {title}
        </span>
        <button
          type="button"
          data-markdown-mode-toggle
          className="inline-flex h-7 shrink-0 items-center rounded-full border border-[var(--wb-border-strong)] bg-[var(--wb-chip)] px-3 text-[12px] leading-5 text-[var(--wb-text-strong)] hover:bg-[var(--wb-chip-hover)]"
          onClick={() => {
            const next = nextMarkdownViewMode(shown);
            rememberMarkdownViewMode(path, next);
            setModeState({ path, mode: next });
          }}
        >
          {markdownModeButtonLabel(shown)}
        </button>
      </div>
      <div ref={rootRef} className="min-h-0 flex-1">
        {body}
        {status === "ready" && path ? (
          <SelectionMenu
            rootRef={rootRef}
            readDraft={(root) => fileSelectionDraft(root, path)}
            onAdd={(draft) => {
              addSessionTextSnippet(sessionId, draft);
            }}
          />
        ) : null}
      </div>
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
