import { useRef, useState } from "react";
import { Folder } from "lucide-react";

import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { previewKindForPath } from "../core/preview-kind";
import { ImageFrame } from "../viewers/image";
import { MarkdownPreview } from "../viewers/MarkdownPreview";
import { SourceView } from "../viewers/SourceView";
import { TextPreview } from "../viewers/TextPreview";
import { SelectionMenu } from "../viewers/SelectionMenu";
import type { SelectionDraft } from "../viewers/selection-quote";
import {
  markdownModeButtonLabel,
  markdownViewMode,
  nextMarkdownViewMode,
  rememberMarkdownViewMode,
  type MarkdownViewMode,
} from "../viewers/markdown-mode";
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
      <Folder className="h-12 w-12 text-zinc-500" strokeWidth={1.25} />
      <p className="text-sm text-zinc-100">{DESKTOP_ZH.openFiles}</p>
      <p className="text-xs text-zinc-500">{DESKTOP_ZH.openFilesHint}</p>
    </div>
  );
}

/** 给定 path 之后的内容。状态壳在查看器外面，Markdown 模式在内容层里面。 */
export function FilePreview({
  projectId,
  path,
  line,
  quotePath,
  onQuote,
}: {
  projectId: string;
  path: string;
  line: number | null;
  quotePath?: string;
  onQuote: (draft: SelectionDraft) => void;
}) {
  const extensionImage = previewKindForPath(path) === "image";
  const unsupported = isUnsupportedPreviewPath(path);
  const state = usePreviewFile(projectId, extensionImage || unsupported ? "" : path);
  const image = extensionImage || (!unsupported && state.status === "ready" && state.kind === "image");
  const picture = usePreviewImage(projectId, image ? path : "");
  const rootRef = useRef<HTMLDivElement>(null);
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
      ref={rootRef}
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
          <PreviewContent path={path} text={readyText.text} kind={readyText.kind} line={line} />
        ) : null}
      </div>
      {shell === "ready" && readyText ? <SelectionMenu rootRef={rootRef} path={quotePath || path} onAdd={onQuote} /> : null}
    </div>
  );
}

function PreviewContent({
  path,
  text,
  kind,
  line,
}: {
  path: string;
  text: string;
  kind: string;
  line: number | null;
}) {
  if (line != null) {
    return (
      <div data-content-viewer="text" className="h-full min-h-0">
        <SourceView text={text} line={line} />
      </div>
    );
  }
  if (kind === "markdown") return <MarkdownFileContent path={path} text={text} />;
  return (
    <div data-content-viewer="text" className="h-full min-h-0">
      <TextPreview text={text} truncated={false} />
    </div>
  );
}

function MarkdownFileContent({ path, text }: { path: string; text: string }) {
  const [modeState, setModeState] = useState<{ path: string; mode: MarkdownViewMode }>(() => ({
    path,
    mode: markdownViewMode(path),
  }));
  if (modeState.path !== path) setModeState({ path, mode: markdownViewMode(path) });
  const shown = modeState.path === path ? modeState.mode : markdownViewMode(path);
  return (
    <div data-content-viewer="markdown" data-markdown-view={shown} className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 justify-end border-b border-[#222] px-3 py-1.5">
        <button
          type="button"
          data-markdown-mode-toggle
          className="inline-flex h-7 shrink-0 items-center rounded-full border border-[#3a3a3a] bg-[#2a2a2a] px-3 text-[12px] leading-5 text-[#f3f3f3] hover:bg-[#333]"
          onClick={() => {
            const next = nextMarkdownViewMode(shown);
            rememberMarkdownViewMode(path, next);
            setModeState({ path, mode: next });
          }}
        >
          {markdownModeButtonLabel(shown)}
        </button>
      </div>
      <div className="min-h-0 flex-1">
        {shown === "source" ? <TextPreview text={text} truncated={false} /> : <MarkdownPreview text={text} truncated={false} />}
      </div>
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
      <p className={status === "error" ? "text-sm text-red-300" : "text-sm text-zinc-100"}>{children}</p>
      {detail ? <p className="text-xs text-zinc-500">{detail}</p> : null}
    </div>
  );
}
