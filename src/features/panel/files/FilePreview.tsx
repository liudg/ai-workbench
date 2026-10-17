import { useState } from "react";

import { previewKindForPath } from "../core/preview-kind";
import {
  markdownModeButtonLabel,
  markdownViewMode,
  nextMarkdownViewMode,
  rememberMarkdownViewMode,
  type MarkdownViewMode,
} from "../viewers/markdown-mode";
import type { SelectionDraft } from "../viewers/selection-quote";
import { previewSelection } from "./file-preview-nav";
import { FileSearchDialog } from "./FileSearchDialog";
import { PreviewChrome } from "./PreviewChrome";
import { FilePreview, PreviewEmpty } from "./PreviewBody";
import { useChooseApp, useOpenProjectFile } from "./useOpenProjectFile";

/** 预览列：顶栏 chrome，下面是空态或某个 path 的内容。 */
export function FilePreviewColumn({
  projectId,
  projectPath,
  previewPath,
  previewLine,
  treeOpen,
  onToggleTree,
  onSelectFile,
  quotePath,
  onQuote,
}: {
  projectId: string;
  projectPath: string;
  previewPath: string;
  previewLine: number | null;
  treeOpen: boolean;
  onToggleTree: () => void;
  onSelectFile: (path: string, intent: { isPreview: true }, line?: number | null) => void;
  quotePath?: string;
  onQuote: (draft: SelectionDraft) => void;
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const markdown = Boolean(previewPath) && previewKindForPath(previewPath) === "markdown";
  const [modeState, setModeState] = useState<{ path: string; mode: MarkdownViewMode }>(() => ({
    path: previewPath,
    mode: markdownViewMode(previewPath),
  }));
  if (markdown && modeState.path !== previewPath) {
    setModeState({ path: previewPath, mode: markdownViewMode(previewPath) });
  }
  const markdownMode = markdown ? (modeState.path === previewPath ? modeState.mode : markdownViewMode(previewPath)) : null;
  const chooseApp = useChooseApp();
  const opener = useOpenProjectFile(projectId);
  return (
    <div data-file-preview-column className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <PreviewChrome
        path={previewPath}
        root={projectPath}
        projectId={projectId}
        treeOpen={treeOpen}
        onToggleTree={onToggleTree}
        searchEnabled={Boolean(projectId)}
        onSearch={() => setSearchOpen(true)}
        onSelectFile={(path, intent) => onSelectFile(path, intent, null)}
        markdownLabel={markdownMode ? markdownModeButtonLabel(markdownMode) : null}
        onToggleMarkdown={
          markdownMode
            ? () => {
                const next = nextMarkdownViewMode(markdownMode);
                rememberMarkdownViewMode(previewPath, next);
                setModeState({ path: previewPath, mode: next });
              }
            : undefined
        }
        chooseApp={chooseApp}
        openNote={opener.note}
        onOpenWith={(mode) => {
          void opener.openWith(previewPath, mode);
        }}
      />
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
          />
        ) : (
          <PreviewEmpty />
        )}
      </div>
      {searchOpen && projectId ? (
        <FileSearchDialog
          projectId={projectId}
          onClose={() => setSearchOpen(false)}
          onOpen={(next, line) => {
            const selected = previewSelection(next, "file");
            if (!selected) return;
            onSelectFile(selected.path, { isPreview: true }, line);
            setSearchOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}
