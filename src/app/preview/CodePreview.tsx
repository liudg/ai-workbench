import { useState } from "react";
import source from "@/features/panel/viewers/SourceView.tsx?raw";

import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { buildFileTree, type FileTreeFile } from "@/features/panel/files/file-tree";
import { FileTreeList } from "@/features/panel/files/FileTreeList";
import { PreviewEmpty } from "@/features/panel/files/PreviewBody";
import { PreviewChrome } from "@/features/panel/files/PreviewChrome";
import { SourceView } from "@/features/panel/viewers/SourceView";

const PATH = "src/features/panel/viewers/SourceView.tsx";

const FILES: FileTreeFile[] = [
  { path: PATH, added: 0, removed: 0 },
  { path: "src/features/panel/viewers/line-comments.tsx", added: 0, removed: 0 },
  { path: "src/features/panel/viewers/highlight.ts", added: 0, removed: 0 },
  { path: "src/features/panel/files/FilePreview.tsx", added: 0, removed: 0 },
];

/** 开发预览：用仓库里的真实源码看打开文件的排版，不写进安装包。 */
export default function CodePreview() {
  const line = source.split("\n").findIndex((row) => row.includes("data-source-line")) + 1;
  const [path, setPath] = useState("");
  const [treeOpen, setTreeOpen] = useState(true);
  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[#0f0f0f] text-[#e8e8e8]" data-file-tree={treeOpen ? "visible" : "hidden"}>
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
              <p data-preview-shell="error" className="px-6 py-8 text-center text-sm text-red-300">
                无法读取文件
              </p>
            ) : (
              <PreviewEmpty />
            )}
          </div>
        </div>
        {treeOpen ? (
          <aside data-workspace-tree data-tree-surface="sidebar" className="flex h-full w-[220px] shrink-0 flex-col overflow-hidden border-l border-[#222] bg-[#0f0f0f]">
          <div className="border-b border-[#222] p-2">
            <input
              readOnly
              value=""
              placeholder={DESKTOP_ZH.filterFiles}
              aria-label={DESKTOP_ZH.filterFiles}
              className="w-full min-w-0 rounded-md border border-[#2a2a2a] bg-[#171717] px-2 py-1.5 text-[12px] text-[#e8e8e8] outline-none placeholder:text-[#666]"
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
