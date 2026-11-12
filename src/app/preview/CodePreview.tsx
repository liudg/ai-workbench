import { useState } from "react";
import source from "./CodePreview.tsx?raw";

import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import {
  buildFileTree,
  FileTreeList,
  PreviewChrome,
  PreviewEmpty,
  SourceView,
  type FileTreeFile,
} from "@/features/panel";

const PATH = "src/app/preview/CodePreview.tsx";

const FILES: FileTreeFile[] = [
  { path: PATH, added: 0, removed: 0 },
  { path: "src/app/preview/DiffPreview.tsx", added: 0, removed: 0 },
  { path: "src/app/preview/FilesPreview.tsx", added: 0, removed: 0 },
  { path: "src/app/preview/PreviewSession.tsx", added: 0, removed: 0 },
];

/** 开发预览：用仓库里的真实源码看打开文件的排版，不写进安装包。 */
export default function CodePreview() {
  const line = source.split("\n").findIndex((row) => row.includes("<SourceView")) + 1;
  const [path, setPath] = useState("");
  const [treeOpen, setTreeOpen] = useState(true);
  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-wb-panel text-wb-fg" data-file-tree={treeOpen ? "visible" : "hidden"}>
      <PreviewChrome
        path={path}
        projectId=""
        treeOpen={treeOpen}
        onToggleTree={() => setTreeOpen((open) => !open)}
        searchEnabled={false}
        onSearch={() => {}}
        onSelectFile={(next) => setPath(next)}
        onOpenWith={() => {}}
      />
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">
            {path === PATH ? (
              <div data-content-viewer="text" className="h-full min-h-0">
                <SourceView text={source} line={line > 0 ? line : 1} />
              </div>
            ) : path ? (
              <p data-preview-shell="error" className="px-6 py-8 text-center text-sm text-wb-danger">
                无法读取文件
              </p>
            ) : (
              <PreviewEmpty />
            )}
          </div>
        </div>
        {treeOpen ? (
          <aside data-workspace-tree data-tree-surface="sidebar" className="flex h-full w-[220px] shrink-0 flex-col overflow-hidden border-l border-wb-border bg-wb-panel">
          <div className="border-b border-wb-border p-2">
            <input
              readOnly
              value=""
              placeholder={DESKTOP_ZH.filterFiles}
              aria-label={DESKTOP_ZH.filterFiles}
              className="w-full min-w-0 rounded-lg border border-wb-border-strong bg-wb-input px-2.5 py-1.5 text-[12px] text-wb-fg outline-none transition-colors placeholder:text-wb-dim focus-visible:border-wb-accent focus-visible:ring-2 focus-visible:ring-wb-accent-soft"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1">
            <FileTreeList
              nodes={buildFileTree(FILES)}
              collapsed={new Set()}
              activePath={path}
              rowAttr="data-workspace-file"
              showStats={false}
              onToggle={() => {}}
              onSelect={(file) => setPath(file.path)}
            />
          </div>
          </aside>
        ) : null}
      </div>
    </div>
  );
}
