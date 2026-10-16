import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Copy, FolderTree, Search } from "lucide-react";

import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { relativeToProject } from "@/shared/path";
import { cn } from "@/lib/utils";
import { breadcrumbSegments, dropdownTreeQuery } from "./file-preview-nav";
import { WorkspaceTree } from "./WorkspaceTree";

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

function BreadcrumbMenu({
  anchor,
  projectId,
  activePath,
  segmentPath,
  last,
  workspaceRoot,
  onSelectFile,
  onClose,
}: {
  anchor: HTMLButtonElement | null;
  projectId: string;
  activePath: string;
  segmentPath: string;
  last: boolean;
  workspaceRoot: string;
  onSelectFile: (path: string, intent: { isPreview: true }) => void;
  onClose: () => void;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLButtonElement | null>(anchor);
  anchorRef.current = anchor;
  const query = dropdownTreeQuery({ activePath, segmentPath, last, workspaceRoot });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const onPointer = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (popoverRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onPointer);
    };
  }, [onClose]);

  useEffect(() => {
    const place = () => {
      const button = anchorRef.current;
      const layer = popoverRef.current;
      if (!button || !layer) return;
      const rect = button.getBoundingClientRect();
      const width = layer.offsetWidth;
      const height = layer.offsetHeight;
      let left = rect.left;
      left = Math.min(Math.max(8, left), window.innerWidth - width - 8);
      let top = rect.bottom + 6;
      if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
      layer.style.top = `${top}px`;
      layer.style.left = `${left}px`;
    };
    place();
    const frame = requestAnimationFrame(place);
    window.addEventListener("resize", place);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", place);
    };
  }, [segmentPath, projectId]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={popoverRef}
      role="dialog"
      data-breadcrumb-menu
      data-open-mode={query.openMode}
      data-should-expand={query.shouldExpandActivePath ? "true" : "false"}
      aria-label={DESKTOP_ZH.breadcrumbLabel}
      className="fixed z-[80] flex h-80 w-80 flex-col overflow-hidden rounded-xl border border-[#2a2a2a] bg-[#141414] shadow-[0_12px_32px_rgba(0,0,0,0.45)]"
    >
      <div className="min-h-0 flex-1 overflow-auto px-1 py-1">
        {projectId ? (
          <WorkspaceTree
            projectId={projectId}
            filter=""
            activePath={activePath}
            surface={query.surface}
            directoryPath={query.directoryPath}
            initialExpanded={query.expandedPaths}
            revealSelectedPath={query.revealSelectedPath}
            openMode={query.openMode}
            includeHidden={query.includeHidden}
            onSelectFile={onSelectFile}
          />
        ) : (
          <p className="px-2 py-6 text-center text-xs text-red-300" data-directory-error>
            {DESKTOP_ZH.directoryError}
          </p>
        )}
      </div>
    </div>,
    document.body,
  );
}

async function writeClipboardText(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // 剪贴板权限被拒绝时改用选区。
    }
  }
  if (typeof document === "undefined") throw new Error(DESKTOP_ZH.diffCopyFailed);
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.left = "-9999px";
  document.body.appendChild(area);
  area.focus();
  area.select();
  const copied = document.execCommand("copy");
  area.remove();
  if (!copied) throw new Error(DESKTOP_ZH.diffCopyFailed);
}
