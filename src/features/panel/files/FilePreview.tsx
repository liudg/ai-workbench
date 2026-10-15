import { useRef } from "react";

import { pathCrumb } from "./path";
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
      <div className="shrink-0 truncate border-b border-[#222] px-3 py-2 font-mono text-[12px] text-[#bdbdbd]">
        {pathCrumb(path)}
      </div>
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
