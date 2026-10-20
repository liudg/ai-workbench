import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { AppWindow, ChevronDown, Copy, Folder, Search } from "lucide-react";

import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { writeClipboardText } from "@/shared/clipboard";
import { relativeToProject } from "@/shared/path";
import { cn } from "@/lib/utils";
import { Hint } from "../core/Hint";
import { useAnchoredLayer } from "../core/useAnchoredLayer";
import { useDismissLayer } from "../core/useDismissLayer";
import { previewCrumbs, previewRootLabel } from "./file-preview-nav";
import { BreadcrumbMenu } from "./BreadcrumbMenu";
import { openWithActions, type OpenWithAction, type OpenWithItem } from "./open-with";

/** 打开文件顶栏：路径在左，操作靠右，一行横跨预览和文件树。 */
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
  const anchors = useRef(new Map<string, HTMLElement>());
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
    <div
      data-preview-chrome
      data-preview-toolbar
      className="flex h-10 min-w-0 shrink-0 flex-nowrap items-center gap-2 border-b border-[#222] bg-[#0f0f0f] px-2 text-[12px] text-[#bdbdbd]"
    >
      <nav
        data-slot="file-path"
        aria-label={DESKTOP_ZH.breadcrumbLabel}
        data-preview-path-line
        className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap"
      >
        {segments.map((segment, index) => (
          <span key={`${segment.path}:${segment.label}`} className="inline whitespace-nowrap align-middle">
            {index > 0 ? (
              <span aria-hidden className="px-1 text-[#666]">
                &gt;
              </span>
            ) : null}
            <button
              type="button"
              data-breadcrumb-segment={segment.path || segment.label}
              data-open-mode={segment.last ? "file" : "workspace"}
              aria-expanded={openPath === segment.path}
              title={segment.label}
              className="contents"
              onClick={() => setOpenPath((current) => (current === segment.path ? null : segment.path))}
            >
              <span
                ref={(node) => {
                  if (node) anchors.current.set(segment.path, node);
                  else anchors.current.delete(segment.path);
                }}
                className={cn(
                  "rounded px-1 py-0.5 hover:bg-white/[0.06]",
                  segment.last ? "font-medium text-[#f3f3f3]" : "text-[#bdbdbd]",
                )}
              >
                {segment.label}
              </span>
            </button>
          </span>
        ))}
      </nav>
      <div data-preview-actions className="ml-auto flex shrink-0 items-center gap-1">
        <button
          type="button"
          data-file-search-open
          aria-label={DESKTOP_ZH.openFilesSearch}
          title={searchEnabled ? DESKTOP_ZH.openFilesSearch : DESKTOP_ZH.previewSearchUnavailable}
          disabled={!searchEnabled}
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[#cfcfcf] hover:bg-white/5 disabled:text-[#555]"
          onClick={onSearch}
        >
          <Search className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
          <span>{DESKTOP_ZH.openFilesSearch}</span>
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
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[#cfcfcf] hover:bg-white/5 disabled:text-[#555]"
          onClick={() => void copyPath()}
        >
          <Copy className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
          <span>{copyNote || DESKTOP_ZH.copyPath}</span>
        </button>
        {onOpenWith ? (
          <div
            data-open-with
            className="inline-flex h-7 shrink-0 items-stretch overflow-hidden rounded-full border border-[#3a3a3a] bg-[#2a2a2a] text-[#e8e8e8]"
          >
            <button
              type="button"
              data-open-with-default
              aria-label={DESKTOP_ZH.openFileDefault}
              disabled={!shown}
              className="inline-flex items-center gap-1 rounded-l-full pl-2 pr-1.5 hover:bg-white/10 disabled:text-[#555] disabled:hover:bg-transparent"
              onClick={() => onOpenWith("default")}
            >
              <AppWindow className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
              <span className="max-w-16 truncate">{openNote || DESKTOP_ZH.openFile}</span>
            </button>
            <span data-open-with-divider aria-hidden className="h-3.5 w-px shrink-0 self-center bg-[#555]" />
            <button
              type="button"
              ref={openAnchor}
              data-open-with-menu-button
              aria-label={DESKTOP_ZH.openFileMenu}
              aria-expanded={openMenu}
              aria-haspopup="menu"
              aria-controls={menuId}
              disabled={!shown}
              className="inline-flex w-7 items-center justify-center rounded-r-full hover:bg-white/10 disabled:text-[#555] disabled:hover:bg-transparent"
              onClick={toggleOpenMenu}
            >
              <ChevronDown className="h-3.5 w-3.5" strokeWidth={1.75} />
            </button>
          </div>
        ) : null}
        <Hint label={DESKTOP_ZH.toggleFileTree} align="end">
          <button
            type="button"
            data-toggle-file-tree
            aria-label={DESKTOP_ZH.toggleFileTree}
            aria-pressed={treeOpen}
            className={cn(
              "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px]",
              treeOpen ? "bg-white/10 text-[#e8e8e8]" : "text-[#8d8d8d] hover:bg-white/5 hover:text-[#e8e8e8]",
            )}
            onClick={onToggleTree}
          >
            <Folder data-file-tree-icon="folder" className="h-3.5 w-3.5" />
          </button>
        </Hint>
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
