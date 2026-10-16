import { useEffect, useRef, useState } from "react";
import { Copy, FolderTree, Search } from "lucide-react";

import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { writeClipboardText } from "@/shared/clipboard";
import { relativeToProject } from "@/shared/path";
import { cn } from "@/lib/utils";
import { breadcrumbSegments } from "./file-preview-nav";
import { BreadcrumbMenu } from "./BreadcrumbMenu";

/** 预览顶栏：路径、复制、全库搜索、文件树显隐。内容查看器不放在这里。 */
export function PreviewChrome({
  path,
  root = "",
  projectId,
  treeOpen,
  onToggleTree,
  onSelectFile,
  onSearch,
  searchEnabled,
}: {
  path: string;
  root?: string;
  projectId: string;
  treeOpen: boolean;
  onToggleTree: () => void;
  onSelectFile: (path: string, intent: { isPreview: true }) => void;
  onSearch: () => void;
  searchEnabled: boolean;
}) {
  const relative = root ? relativeToProject(path, root) : path;
  const shown = relative || path;
  const segments = breadcrumbSegments(shown);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [copyNote, setCopyNote] = useState("");
  const anchors = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    setOpenPath(null);
    setCopyNote("");
  }, [shown]);

  useEffect(() => {
    if (!copyNote) return;
    const timer = window.setTimeout(() => setCopyNote(""), 1500);
    return () => window.clearTimeout(timer);
  }, [copyNote]);

  const copyPath = async () => {
    if (!shown) return;
    try {
      await writeClipboardText(shown);
      setCopyNote(DESKTOP_ZH.pathCopied);
    } catch {
      setCopyNote(DESKTOP_ZH.diffCopyFailed);
    }
  };

  const openSegment = segments.find((segment) => segment.path === openPath) ?? null;

  return (
    <div
      data-preview-chrome
      className="flex shrink-0 items-center gap-1 border-b border-[#222] px-2 py-1.5 text-[12px] text-[#bdbdbd]"
    >
      <nav
        data-slot="file-path"
        aria-label={DESKTOP_ZH.breadcrumbLabel}
        data-preview-path-line
        className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden"
      >
        {segments.map((segment, index) => (
          <span key={segment.path} className="flex min-w-0 items-center gap-1">
            {index > 0 ? (
              <span aria-hidden className="shrink-0 text-[#666]">
                &gt;
              </span>
            ) : null}
            <button
              type="button"
              ref={(node) => {
                if (node) anchors.current.set(segment.path, node);
                else anchors.current.delete(segment.path);
              }}
              data-breadcrumb-segment={segment.path}
              data-open-mode={segment.last ? "file" : "workspace"}
              aria-expanded={openPath === segment.path}
              title={segment.label}
              className={cn(
                "max-w-[12rem] truncate rounded px-1 py-0.5 hover:bg-white/[0.06]",
                segment.last ? "font-medium text-[#f3f3f3]" : "text-[#bdbdbd]",
              )}
              onClick={() => setOpenPath((current) => (current === segment.path ? null : segment.path))}
            >
              {segment.label}
            </button>
          </span>
        ))}
      </nav>
      <div data-slot="path-actions" className="flex shrink-0 items-center">
        <button
          type="button"
          data-copy-path
          aria-label={DESKTOP_ZH.copyPath}
          disabled={!shown}
          className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[#cfcfcf] hover:bg-white/5 disabled:text-[#555]"
          onClick={() => void copyPath()}
        >
          <Copy className="h-3.5 w-3.5" strokeWidth={1.75} />
          <span>{copyNote || DESKTOP_ZH.copyPath}</span>
        </button>
      </div>
      <div data-slot="workspace-search" className="flex shrink-0 items-center">
        <button
          type="button"
          data-file-search-open
          aria-label={DESKTOP_ZH.openFilesSearch}
          title={searchEnabled ? DESKTOP_ZH.openFilesSearch : DESKTOP_ZH.previewSearchUnavailable}
          disabled={!searchEnabled}
          className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[#cfcfcf] hover:bg-white/5 disabled:text-[#555]"
          onClick={onSearch}
        >
          <Search className="h-3.5 w-3.5" strokeWidth={1.75} />
          <span>{DESKTOP_ZH.openFilesSearch}</span>
        </button>
      </div>
      <div data-slot="file-actions" className="flex shrink-0 items-center">
        <button
          type="button"
          data-toggle-file-tree
          aria-label={DESKTOP_ZH.toggleFileTree}
          aria-pressed={treeOpen}
          title={DESKTOP_ZH.toggleFileTree}
          className={cn(
            "inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-white/5",
            treeOpen ? "text-[#f3f3f3]" : "text-[#8d8d8d]",
          )}
          onClick={onToggleTree}
        >
          <FolderTree className="h-3.5 w-3.5" strokeWidth={1.75} />
        </button>
      </div>
      {openSegment ? (
        <BreadcrumbMenu
          anchor={anchors.current.get(openSegment.path) ?? null}
          projectId={projectId}
          activePath={shown}
          segmentPath={openSegment.path}
          last={openSegment.last}
          workspaceRoot={root}
          onSelectFile={(next, intent) => {
            setOpenPath(null);
            onSelectFile(next, intent);
          }}
          onClose={() => setOpenPath(null)}
        />
      ) : null}
    </div>
  );
}
