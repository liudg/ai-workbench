import { Folder } from "lucide-react";

import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { previewKindForPath } from "../core/preview-kind";
import { ImageFrame } from "../viewers/image";
import { FileContent } from "../viewers/FileContent";
import type { SelectionDraft } from "../viewers/selection-quote";
import { markdownModeButtonLabel, type MarkdownViewMode } from "../viewers/markdown-mode";
import { isUnsupportedPreviewPath, previewShellStatus, type PreviewShellStatus } from "./file-preview-nav";
import { usePreviewFile } from "./usePreviewFile";
import { usePreviewImage } from "./usePreviewImage";

/** 还没有 path 时的预览壳。文件要从树或面包屑里选。 */
export function PreviewEmpty() {
  return (
    <div
      data-open-files-empty
      data-preview-shell="empty"
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center"
    >
      <Folder className="h-10 w-10 text-wb-fg-3" strokeWidth={1.25} />
      <p className="text-sm font-medium text-wb-fg">{DESKTOP_ZH.openFiles}</p>
      <p className="text-xs text-wb-fg-3">{DESKTOP_ZH.openFilesHint}</p>
    </div>
  );
}

/** 给定 path 之后的内容。状态壳在查看器外面，Markdown 模式由顶栏同一排切换。 */
export function FilePreview({
  projectId,
  path,
  line,
  quotePath,
  onQuote,
  markdownMode = null,
  onToggleMarkdown,
}: {
  projectId: string;
  path: string;
  line: number | null;
  quotePath?: string;
  onQuote: (draft: SelectionDraft) => void;
  markdownMode?: MarkdownViewMode | null;
  onToggleMarkdown?: () => void;
}) {
  const extensionImage = previewKindForPath(path) === "image";
  const unsupported = isUnsupportedPreviewPath(path);
  const state = usePreviewFile(projectId, extensionImage || unsupported ? "" : path);
  const image = extensionImage || (!unsupported && state.status === "ready" && state.kind === "image");
  const picture = usePreviewImage(projectId, image ? path : "");
  const phase = image
    ? picture.status === "error"
      ? "error"
      : picture.status === "ready"
        ? "ready"
        : "loading"
    : unsupported
      ? "ready"
      : state.status;
  const shell = previewShellStatus({
    path,
    phase,
    kind: image ? "image" : state.status === "ready" ? state.kind : undefined,
    truncated: !image && state.status === "ready" ? state.truncated : false,
  });
  const errorMessage =
    state.status === "error" ? state.message : picture.status === "error" ? picture.message : "";
  const readyText = !image && state.status === "ready" ? state : null;

  return (
    <div
      data-open-files-preview
      data-preview-path={path}
      data-preview-line={line ?? ""}
      data-preview-status={shell}
      className="flex h-full min-h-0 flex-col"
    >
      <div className="min-h-0 flex-1">
        {shell === "loading" ? <StatusShell status="loading">{DESKTOP_ZH.filesReading}</StatusShell> : null}
        {shell === "error" ? <StatusShell status="error">{errorMessage || "无法读取文件"}</StatusShell> : null}
        {shell === "tooLarge" ? (
          <StatusShell status="tooLarge" detail={DESKTOP_ZH.previewTooLargeDetail}>
            {DESKTOP_ZH.previewTooLarge}
          </StatusShell>
        ) : null}
        {shell === "unsupported" ? (
          <StatusShell status="unsupported" detail={DESKTOP_ZH.previewUnsupportedDetail}>
            {DESKTOP_ZH.previewUnsupported}
          </StatusShell>
        ) : null}
        {shell === "ready" && image && picture.status === "ready" ? (
          <div data-content-viewer="image" className="h-full min-h-0">
            <ImageFrame src={picture.src} name={picture.name} />
          </div>
        ) : null}
        {shell === "ready" && readyText ? (
          <PreviewContent
            text={readyText.text}
            kind={readyText.kind}
            line={line}
            path={path}
            quotePath={quotePath || path}
            onQuote={onQuote}
            markdownMode={markdownMode}
            onToggleMarkdown={onToggleMarkdown}
          />
        ) : null}
      </div>
    </div>
  );
}

function PreviewContent({
  text,
  kind,
  line,
  path,
  quotePath,
  onQuote,
  markdownMode,
  onToggleMarkdown,
}: {
  text: string;
  kind: string;
  line: number | null;
  path: string;
  quotePath: string;
  onQuote: (draft: SelectionDraft) => void;
  markdownMode: MarkdownViewMode | null;
  onToggleMarkdown?: () => void;
}) {
  const markdown = kind === "markdown";
  const view = markdown && markdownMode !== "source" ? "markdown" : "source";
  return (
    <div
      data-content-viewer={view === "markdown" || (markdown && line == null) ? "markdown" : "text"}
      data-markdown-view={markdown ? (view === "markdown" ? "preview" : "source") : undefined}
      className="h-full min-h-0"
    >
      <FileContent
        view={view}
        text={text}
        line={view === "source" ? line : null}
        quotePath={quotePath}
        copyPath={path}
        commentable={!markdown}
        markdown={
          markdown && markdownMode && onToggleMarkdown
            ? { label: markdownModeButtonLabel(markdownMode), onToggle: onToggleMarkdown }
            : null
        }
        onAdd={onQuote}
      />
    </div>
  );
}

function StatusShell({
  status,
  detail,
  children,
}: {
  status: PreviewShellStatus;
  detail?: string;
  children: string;
}) {
  return (
    <div data-preview-shell={status} className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <p className={status === "error" ? "text-sm text-wb-danger" : "text-sm text-wb-fg"}>{children}</p>
      {detail ? <p className="text-xs text-wb-fg-3">{detail}</p> : null}
    </div>
  );
}
