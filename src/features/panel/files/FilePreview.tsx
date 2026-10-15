import { useRef } from "react";
import { File } from "lucide-react";

import { pathCrumb, relativeToProject } from "./path";
import { previewKindForPath } from "../core/preview-kind";
import { ImageFrame } from "../viewers/image";
import { MarkdownPreview } from "../viewers/MarkdownPreview";
import { SourceView } from "../viewers/SourceView";
import { TextPreview } from "../viewers/TextPreview";
import { PreviewFailed, PreviewPending } from "../viewers/frame";
import { SelectionMenu } from "./SelectionMenu";
import { usePreviewFile } from "./usePreviewFile";
import { usePreviewImage } from "./usePreviewImage";

/** 在当前「打开文件」页里预览。不新开标签。 */
export function PreviewPathBar({ path, root = "" }: { path: string; root?: string }) {
  const relative = root ? relativeToProject(path, root) : path;
  const shown = relative || path;
  const parts = shown.split(/[\\/]/).filter(Boolean);
  const name = parts[parts.length - 1] ?? shown;
  const dirs = parts.slice(0, -1);
  return (
    <div
      data-preview-path-line
      className="flex shrink-0 items-center gap-1.5 overflow-hidden border-b border-[#222] px-3 py-2 text-[12px] text-[#bdbdbd]"
    >
      <File className="h-3.5 w-3.5 shrink-0 text-[#8d8d8d]" strokeWidth={1.75} />
      <span className="min-w-0 truncate whitespace-nowrap font-mono" title={pathCrumb(shown)}>
        {dirs.length > 0 ? <span>{dirs.join(" / ")} / </span> : null}
        <span className="font-bold text-[#f3f3f3]">{name}</span>
      </span>
    </div>
  );
}

export function FilePreview({
  projectId,
  path,
  root = "",
  line,
  quotePath,
  onQuote,
}: {
  projectId: string;
  path: string;
  root?: string;
  line: number | null;
  /** 写进对话的路径。缺省用预览里的相对路径。 */
  quotePath?: string;
  onQuote: (quote: string) => void;
}) {
  const image = previewKindForPath(path) === "image";
  const state = usePreviewFile(projectId, image ? "" : path);
  const picture = usePreviewImage(projectId, image ? path : "");
  const rootRef = useRef<HTMLDivElement>(null);

  return (
    <div
      ref={rootRef}
      data-open-files-preview
      data-preview-path={path}
      data-preview-line={line ?? ""}
      data-preview-status={image ? picture.status : state.status}
      className="flex h-full min-h-0 flex-col"
    >
      <PreviewPathBar path={path} root={root} />
      <div className="min-h-0 flex-1">
        {image && picture.status === "loading" ? <PreviewPending /> : null}
        {image && picture.status === "error" ? <PreviewFailed message={picture.message} /> : null}
        {image && picture.status === "ready" ? <ImageFrame src={picture.src} name={picture.name} /> : null}
        {!image && state.status === "loading" ? <PreviewPending /> : null}
        {!image && state.status === "error" ? <PreviewFailed message={state.message} /> : null}
        {!image && state.status === "ready" ? (
          <PreviewBody text={state.text} kind={state.kind} truncated={state.truncated} line={line} />
        ) : null}
      </div>
      {!image && state.status === "ready" ? (
        <SelectionMenu rootRef={rootRef} path={quotePath || path} onAdd={onQuote} />
      ) : null}
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
