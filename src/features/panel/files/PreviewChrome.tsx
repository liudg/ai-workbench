import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { AppWindow, ChevronDown, Copy, FolderTree, Search } from "lucide-react";

import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { writeClipboardText } from "@/shared/clipboard";
import { relativeToProject } from "@/shared/path";
import { cn } from "@/lib/utils";
import { useAnchoredLayer } from "../core/useAnchoredLayer";
import { useDismissLayer } from "../core/useDismissLayer";
import { previewCrumbs, previewRootLabel } from "./file-preview-nav";
import { BreadcrumbMenu } from "./BreadcrumbMenu";
import { openWithActions, type OpenWithAction, type OpenWithItem } from "./open-with";

/** 预览顶栏：路径在上，搜索、Markdown 切换、复制、打开和文件树在同一排。 */
export function PreviewChrome({
  path,
  root = "",
  projectId,
  treeOpen,
  onToggleTree,
  onSelectFile,
  onSearch,
  searchEnabled,
  markdownLabel = null,
  onToggleMarkdown,
  chooseApp = false,
  onOpenWith,
  openNote = "",
}: {
  path: string;
  root?: string;
  projectId: string;
  treeOpen: boolean;
  onToggleTree: () => void;
  onSelectFile: (path: string, intent: { isPreview: true }) => void;
  onSearch: () => void;
  searchEnabled: boolean;
  markdownLabel?: string | null;
  onToggleMarkdown?: () => void;
  chooseApp?: boolean;
  onOpenWith?: (mode: OpenWithAction) => void;
  openNote?: string;
}) {
  const relative = root ? relativeToProject(path, root) : path;
  const shown = relative || path;
  const segments = previewCrumbs(shown, previewRootLabel(root));
  const actions = onOpenWith ? openWithActions(chooseApp) : [];
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [copyNote, setCopyNote] = useState("");
  const [openMenu, setOpenMenu] = useState(false);
  const anchors = useRef(new Map<string, HTMLButtonElement>());
  const openAnchor = useRef<HTMLButtonElement | null>(null);
  const lastMenuToggle = useRef(0);
  const menuId = useId();

  useEffect(() => {
    setOpenPath(null);
    setCopyNote("");
    setOpenMenu(false);
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

  const toggleOpenMenu = () => {
    const now = Date.now();
    if (now - lastMenuToggle.current < 32) return;
    lastMenuToggle.current = now;
    setOpenMenu((open) => !open);
  };

  return (
    <div data-preview-chrome className="flex shrink-0 flex-col border-b border-[#222] text-[12px] text-[#bdbdbd]">
      <nav
        data-slot="file-path"
        aria-label={DESKTOP_ZH.breadcrumbLabel}
        data-preview-path-line
        className="flex min-w-0 items-center gap-1 overflow-hidden px-2 py-1.5"
      >
        {segments.map((segment, index) => (
          <span key={`${segment.path}:${segment.label}`} className="flex min-w-0 items-center gap-1">
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
              data-breadcrumb-segment={segment.path || segment.label}
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
      <div data-preview-toolbar className="flex min-w-0 items-center gap-1 px-2 py-1">
        <div data-preview-toolbar-scroll className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
          <button
            type="button"
            data-file-search-open
            aria-label={DESKTOP_ZH.openFilesSearch}
            title={searchEnabled ? DESKTOP_ZH.openFilesSearch : DESKTOP_ZH.previewSearchUnavailable}
            disabled={!searchEnabled}
            className="inline-flex h-7 min-w-0 items-center gap-1 rounded-md px-2 text-[#cfcfcf] hover:bg-white/5 disabled:text-[#555]"
            onClick={onSearch}
          >
            <Search className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
            <span className="truncate">{DESKTOP_ZH.openFilesSearch}</span>
          </button>
          {markdownLabel && onToggleMarkdown ? (
            <button
              type="button"
              data-markdown-mode-toggle
              className="inline-flex h-7 shrink-0 items-center rounded-full border border-[#3a3a3a] bg-[#2a2a2a] px-3 text-[12px] leading-5 text-[#f3f3f3] hover:bg-[#333]"
              onClick={onToggleMarkdown}
            >
              {markdownLabel}
            </button>
          ) : null}
          <button
            type="button"
            data-copy-path
            aria-label={DESKTOP_ZH.copyPath}
            disabled={!shown}
            className="inline-flex h-7 min-w-0 items-center gap-1 rounded-md px-2 text-[#cfcfcf] hover:bg-white/5 disabled:text-[#555]"
            onClick={() => void copyPath()}
          >
            <Copy className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
            <span className="truncate">{copyNote || DESKTOP_ZH.copyPath}</span>
          </button>
        </div>
        <div data-preview-toolbar-pin className="flex shrink-0 items-center gap-1">
          {onOpenWith ? (
            <div data-open-with className="flex shrink-0 items-center">
              <button
                type="button"
                data-open-with-default
                aria-label={DESKTOP_ZH.openFileDefault}
                disabled={!shown}
                className="inline-flex h-7 shrink-0 items-center gap-1 rounded-l-md px-2 text-[#cfcfcf] hover:bg-white/5 disabled:text-[#555]"
                onClick={() => onOpenWith("default")}
              >
                <AppWindow className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
                <span className="max-w-16 truncate">{openNote || DESKTOP_ZH.openFile}</span>
              </button>
              <button
                type="button"
                ref={openAnchor}
                data-open-with-menu-button
                aria-label={DESKTOP_ZH.openFileMenu}
                aria-expanded={openMenu}
                aria-haspopup="menu"
                aria-controls={menuId}
                disabled={!shown}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-r-md text-[#cfcfcf] hover:bg-white/5 disabled:text-[#555]"
                onClick={toggleOpenMenu}
              >
                <ChevronDown className="h-3.5 w-3.5" strokeWidth={1.75} />
              </button>
            </div>
          ) : null}
          <button
            type="button"
            data-toggle-file-tree
            aria-label={DESKTOP_ZH.toggleFileTree}
            aria-pressed={treeOpen}
            title={DESKTOP_ZH.toggleFileTree}
            className={cn(
              "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md hover:bg-white/5",
              treeOpen ? "text-[#f3f3f3]" : "text-[#8d8d8d]",
            )}
            onClick={onToggleTree}
          >
            <FolderTree className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
        </div>
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
      {openMenu && onOpenWith ? (
        <OpenWithMenu
          menuId={menuId}
          anchorRef={openAnchor}
          items={actions}
          onSelect={(mode) => {
            setOpenMenu(false);
            onOpenWith(mode);
          }}
          onClose={() => setOpenMenu(false)}
        />
      ) : null}
    </div>
  );
}

function OpenWithMenu({
  menuId,
  anchorRef,
  items,
  onSelect,
  onClose,
}: {
  menuId: string;
  anchorRef: RefObject<HTMLButtonElement | null>;
  items: readonly OpenWithItem[];
  onSelect: (mode: OpenWithAction) => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useAnchoredLayer(true, anchorRef, menuRef, items.map((item) => item.id).join(","));
  useDismissLayer(true, onClose);
  useEffect(() => {
    const onPointer = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onCloseRef.current();
    };
    window.addEventListener("mousedown", onPointer);
    return () => window.removeEventListener("mousedown", onPointer);
  }, [anchorRef]);
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={menuRef}
      id={menuId}
      role="menu"
      data-open-with-menu
      className="fixed z-[80] min-w-[168px] rounded-xl border border-[#2a2a2a] bg-[#1b1b1b] py-1 text-[#e8e8e8] shadow-[0_12px_32px_rgba(0,0,0,0.45)]"
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          data-open-with-action={item.id}
          className="flex w-full items-center px-3 py-1.5 text-left text-[13px] hover:bg-white/5"
          onClick={() => onSelect(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
