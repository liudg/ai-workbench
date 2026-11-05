import type { MarkdownViewMode } from "../viewers/markdown-mode";
import type { SelectionDraft } from "../viewers/selection-quote";
import { FilePreview, PreviewEmpty } from "./PreviewBody";

/** 预览列：空态或某个 path 的内容。顶栏在这一列外面。 */
export function FilePreviewColumn({
  projectId,
  previewPath,
  previewLine,
  quotePath,
  onQuote,
  markdownMode = null,
  onToggleMarkdown,
}: {
  projectId: string;
  previewPath: string;
  previewLine: number | null;
  quotePath?: string;
  onQuote: (draft: SelectionDraft) => void;
  markdownMode?: MarkdownViewMode | null;
  onToggleMarkdown?: () => void;
}) {
  return (
    <div data-file-preview-column className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="min-h-0 flex-1">
        {previewPath ? (
          <FilePreview
            key={`${previewPath}:${previewLine ?? ""}`}
            projectId={projectId}
            path={previewPath}
            line={previewLine}
            quotePath={quotePath}
            onQuote={onQuote}
            markdownMode={markdownMode}
            onToggleMarkdown={onToggleMarkdown}
          />
        ) : (
          <PreviewEmpty />
        )}
      </div>
    </div>
  );
}
