import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FileSearch, Folder } from "lucide-react";

import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { useElementWidth } from "@/shared/dom/useElementWidth";
import { useWorkbench } from "@/store";
import { cn } from "@/lib/utils";
import { ColumnSplitter } from "../core/ColumnSplitter";
import { FILES_EXPANDED_WIDTH, diffListWidth, diffListWidthAfterDrag } from "../core/layout";
import { resolvePreviewPath } from "../core/preview-kind";
import { usePanel } from "../core/PanelProvider";
import { Hint } from "../core/Hint";
import { FolderStackIcon } from "../core/panel-icons";
import { FileSearchDialog } from "./FileSearchDialog";
import { FileTreeList } from "./FileTreeList";
import { filterFiles } from "./file-filter";
import { buildFileTree, type FileTreeFile } from "./file-tree";
import { baseName, workspaceRootLabel } from "./path";
import { useWorkspaceTree } from "./useWorkspaceTree";

const SPLITTER_WIDTH = 6;

/** 打开文件：中间停在空态，右侧是工作区树。点文件打开预览。 */
export function OpenFilesView() {
  const { projectId, projectPath, sessionId, diffFilesWidth, setDiffFilesWidth, openHref } = usePanel();
  const paths = useWorkspaceTree(projectId);
  const [filter, setFilter] = useState("");
  const [treeOpen, setTreeOpen] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [activePath, setActivePath] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const paneWidth = useElementWidth(frameRef);
  const root = workspaceRootLabel(projectPath);
  const files = useMemo<FileTreeFile[]>(() => paths.map((path) => ({ path, added: 0, removed: 0 })), [paths]);
  const shown = useMemo(() => filterFiles(files, filter), [files, filter]);
  const tree = useMemo(() => buildFileTree(shown), [shown]);
  const inner = treeOpen ? Math.max(0, paneWidth - SPLITTER_WIDTH) : paneWidth;
  const auto = treeOpen ? diffListWidth(inner) : null;
  const dragged = treeOpen && diffFilesWidth !== null ? diffListWidthAfterDrag(inner, diffFilesWidth) : null;
  const listWidth = !treeOpen
    ? null
    : paneWidth <= 0
      ? FILES_EXPANDED_WIDTH
      : (dragged ?? auto ?? Math.min(FILES_EXPANDED_WIDTH, inner));
  const metrics = useRef({ pane: 0, list: 0 });
  const widthRef = useRef(diffFilesWidth);
  metrics.current = { pane: inner, list: listWidth ?? auto ?? 0 };
  widthRef.current = diffFilesWidth;

  const openFile = (path: string, line?: number | null) => {
    setActivePath(path);
    openHref(path, line ?? undefined);
  };

  const addToChat = (path: string) => {
    const absolute = resolvePreviewPath(projectPath, path);
    if (!absolute) return;
    useWorkbench.getState().addAttachments(sessionId, [{ name: baseName(absolute), path: absolute }]);
    setContextMenu(null);
  };

  const toggleDir = (id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div ref={frameRef} data-open-files className="relative flex h-full min-h-0 min-w-0 overflow-hidden" data-file-tree={listWidth === null ? "hidden" : "visible"}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {root ? (
          <div data-open-files-root className="shrink-0 px-3 pt-2 text-xs text-zinc-500">
            {root}
          </div>
        ) : null}
        <div data-open-files-empty className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <Folder className="h-12 w-12 text-zinc-500" strokeWidth={1.25} />
          <p className="text-sm text-zinc-100">{DESKTOP_ZH.openFiles}</p>
          <p className="text-xs text-zinc-500">{DESKTOP_ZH.openFilesHint}</p>
        </div>
      </div>
      {listWidth !== null ? (
        <ColumnSplitter
          name="open-files"
          onDelta={(dx) => {
            const pane = metrics.current.pane;
            const current = diffListWidthAfterDrag(pane, widthRef.current ?? metrics.current.list) ?? metrics.current.list;
            const next = diffListWidthAfterDrag(pane, current - dx);
            if (next !== null) setDiffFilesWidth(next);
          }}
        />
      ) : null}
      {listWidth !== null ? (
        <aside
          data-workspace-tree
          style={{ width: listWidth, minWidth: listWidth }}
          className="flex h-full min-h-0 shrink-0 flex-col overflow-hidden border-l border-zinc-800 bg-zinc-950"
        >
          <div className="flex shrink-0 items-center gap-1 border-b border-zinc-800 p-1.5">
            <input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder={DESKTOP_ZH.filterFiles}
              aria-label={DESKTOP_ZH.filterFiles}
              data-files-filter
              className="w-full min-w-0 rounded-md border border-zinc-800 bg-zinc-900 px-1.5 py-1 text-xs text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-zinc-600"
            />
            <FileColumnTools
              treeOpen={treeOpen}
              onSearch={() => setSearchOpen(true)}
              onToggleTree={() => setTreeOpen((value) => !value)}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1 py-1">
            {shown.length === 0 ? (
              <p className="px-2 py-6 text-center text-xs leading-5 text-zinc-500">{DESKTOP_ZH.noFileMatch}</p>
            ) : (
              <FileTreeList
                nodes={tree}
                collapsed={collapsed}
                activePath={activePath}
                rowAttr="data-workspace-file"
                showStats={false}
                onToggle={toggleDir}
                onSelect={(file) => openFile(file.path)}
                onContextMenu={(file, event) => setContextMenu({ x: event.clientX, y: event.clientY, path: file.path })}
              />
            )}
          </div>
        </aside>
      ) : (
        <div className="absolute right-2 top-2 z-10">
          <FileColumnTools
            treeOpen={false}
            onSearch={() => setSearchOpen(true)}
            onToggleTree={() => setTreeOpen(true)}
          />
        </div>
      )}
      {searchOpen ? (
        <FileSearchDialog
          projectId={projectId}
          onClose={() => setSearchOpen(false)}
          onOpen={(path, line) => openFile(path, line)}
        />
      ) : null}
      {contextMenu ? (
        <FileContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onAdd={() => addToChat(contextMenu.path)}
          onClose={() => setContextMenu(null)}
        />
      ) : null}
    </div>
  );
}

function FileContextMenu({
  x,
  y,
  onAdd,
  onClose,
}: {
  x: number;
  y: number;
  onAdd: () => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const onPointer = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onPointer);
    };
  }, [onClose]);
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const left = Math.min(Math.max(8, x), window.innerWidth - width - 8);
    let top = y;
    if (top + height > window.innerHeight - 8) top = Math.max(8, y - height);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }, [x, y]);
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      data-file-context-menu
      className="fixed z-[80] w-40 rounded-xl border border-zinc-700 bg-zinc-900 py-1 shadow-lg"
      style={{ top: -9999, left: 8 }}
    >
      <button
        type="button"
        role="menuitem"
        data-add-to-chat
        className="flex w-full items-center px-3 py-1.5 text-left text-xs text-zinc-100 hover:bg-zinc-800"
        onClick={onAdd}
      >
        {DESKTOP_ZH.addToChat}
      </button>
    </div>,
    document.body,
  );
}

function FileColumnTools({
  treeOpen,
  onSearch,
  onToggleTree,
}: {
  treeOpen: boolean;
  onSearch: () => void;
  onToggleTree: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1">
      <Hint label={DESKTOP_ZH.openFilesSearch} align="end">
        <button
          type="button"
          data-file-search-open
          aria-label={DESKTOP_ZH.openFilesSearch}
          className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-zinc-700 text-zinc-300 hover:bg-zinc-800"
          onClick={onSearch}
        >
          <FileSearch className="h-3.5 w-3.5" />
        </button>
      </Hint>
      <button
        type="button"
        data-file-tree-toggle
        aria-pressed={treeOpen}
        className={cn(
          "inline-flex h-7 w-7 items-center justify-center rounded-full border border-zinc-700 text-zinc-300 hover:bg-zinc-800",
          treeOpen && "bg-zinc-800 text-zinc-50",
        )}
        onClick={onToggleTree}
      >
        <FolderStackIcon />
      </button>
    </div>
  );
}
