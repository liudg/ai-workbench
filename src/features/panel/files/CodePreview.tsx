import source from "../viewers/SourceView.tsx?raw";

import { FileTreeList } from "./FileTreeList";
import { buildFileTree, type FileTreeFile } from "./file-tree";
import { pathCrumb } from "./path";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { SourceView } from "../viewers/SourceView";

const PATH = "src/features/panel/viewers/SourceView.tsx";

const FILES: FileTreeFile[] = [
  { path: PATH, added: 0, removed: 0 },
  { path: "src/features/panel/viewers/TextPreview.tsx", added: 0, removed: 0 },
  { path: "src/features/panel/viewers/highlight.ts", added: 0, removed: 0 },
  { path: "src/features/panel/files/FilePreview.tsx", added: 0, removed: 0 },
];

/** 开发预览：用仓库里的真实源码看打开文件的排版，不写进安装包。 */
export default function CodePreview() {
  const line = source.split("\n").findIndex((row) => row.includes("data-source-line")) + 1;
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#0f0f0f] text-[#e8e8e8]">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="shrink-0 truncate border-b border-[#222] px-3 py-2 font-mono text-[12px] text-[#bdbdbd]">
          {pathCrumb(PATH)}
        </div>
        <div className="min-h-0 flex-1">
          <SourceView text={source} line={line > 0 ? line : 1} />
        </div>
      </div>
      <aside className="flex h-full w-[220px] shrink-0 flex-col overflow-hidden border-l border-[#222] bg-[#0f0f0f]">
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
            activePath={PATH}
            rowAttr="data-workspace-file"
            showStats={false}
            onToggle={() => {}}
            onSelect={() => {}}
          />
        </div>
      </aside>
    </div>
  );
}
