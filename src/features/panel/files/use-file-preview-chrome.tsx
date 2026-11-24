import { useState } from "react";

import { previewKindForPath } from "../core/preview-kind";
import { useMarkdownPreviewMode } from "../viewers/use-markdown-preview-mode";
import { previewSelection } from "./file-preview-nav";
import type { OpenWithAction } from "./open-with";
import { FileSearchDialog } from "./FileSearchDialog";
import { useChooseApp, useOpenProjectFile } from "./useOpenProjectFile";

/** 顶栏和预览共用搜索、Markdown 模式和外部打开。页面把顶栏放在两栏上面。 */
export function useFilePreviewChrome({
  projectId,
  projectPath,
  previewPath,
  previewLine = null,
  treeOpen,
  onToggleTree,
  onSelectFile,
}: {
  projectId: string;
  projectPath: string;
  previewPath: string;
  previewLine?: number | null;
  treeOpen: boolean;
  onToggleTree: () => void;
  onSelectFile: (path: string, intent: { isPreview: boolean }, line?: number | null) => void;
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const markdown = Boolean(previewPath) && previewKindForPath(previewPath) === "markdown";
  const md = useMarkdownPreviewMode(previewPath, previewLine, markdown);
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
      markdownLabel: md.label,
      onToggleMarkdown: md.mode ? md.toggle : undefined,
      chooseApp,
      openNote: opener.note,
      onOpenWith: (mode: OpenWithAction) => {
        void opener.openWith(previewPath, mode);
      },
    },
    markdownMode: md.mode,
    searchDialog:
      searchOpen && projectId ? (
        <FileSearchDialog
          projectId={projectId}
          onClose={() => setSearchOpen(false)}
          onOpen={(next, line) => {
            const selected = previewSelection(next, "file");
            if (!selected) return;
            if (line != null && previewKindForPath(selected.path) === "markdown") {
              md.openSourceAt(selected.path, line);
            }
            onSelectFile(selected.path, { isPreview: true }, line);
            setSearchOpen(false);
          }}
        />
      ) : null,
  };
}
