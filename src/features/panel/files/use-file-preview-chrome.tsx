import { useState } from "react";

import { previewKindForPath } from "../core/preview-kind";
import {
  markdownModeButtonLabel,
  markdownViewMode,
  nextMarkdownViewMode,
  rememberMarkdownViewMode,
  type MarkdownViewMode,
} from "../viewers/markdown-mode";
import { previewSelection } from "./file-preview-nav";
import type { OpenWithAction } from "./open-with";
import { FileSearchDialog } from "./FileSearchDialog";
import { useChooseApp, useOpenProjectFile } from "./useOpenProjectFile";

/** 顶栏和预览共用搜索、Markdown 模式和外部打开。页面把顶栏放在两栏上面。 */
export function useFilePreviewChrome({
  projectId,
  projectPath,
  previewPath,
  treeOpen,
  onToggleTree,
  onSelectFile,
}: {
  projectId: string;
  projectPath: string;
  previewPath: string;
  treeOpen: boolean;
  onToggleTree: () => void;
  onSelectFile: (path: string, intent: { isPreview: boolean }, line?: number | null) => void;
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
  return {
    chromeProps: {
      path: previewPath,
      root: projectPath,
      projectId,
      treeOpen,
      onToggleTree,
      searchEnabled: Boolean(projectId),
      onSearch: () => setSearchOpen(true),
      onSelectFile: (path: string, intent: { isPreview: boolean }) => onSelectFile(path, intent, null),
      markdownLabel: markdownMode ? markdownModeButtonLabel(markdownMode) : null,
      onToggleMarkdown: markdownMode
        ? () => {
            const next = nextMarkdownViewMode(markdownMode);
            rememberMarkdownViewMode(previewPath, next);
            setModeState({ path: previewPath, mode: next });
          }
        : undefined,
      chooseApp,
      openNote: opener.note,
      onOpenWith: (mode: OpenWithAction) => {
        void opener.openWith(previewPath, mode);
      },
    },
    markdownMode,
    searchDialog:
      searchOpen && projectId ? (
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
      ) : null,
  };
}
