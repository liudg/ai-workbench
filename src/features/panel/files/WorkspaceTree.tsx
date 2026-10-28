import { useEffect, useRef, type MouseEvent as ReactMouseEvent } from "react";
import { ChevronDown, ChevronRight, File } from "lucide-react";

import type { TreeEntry } from "@/types";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { cn } from "@/lib/utils";
import { FileTreeList } from "./FileTreeList";
import { buildFileTree, treePathLabel, type FileTreeFile } from "./file-tree";
import { previewSelection, type FileOpenMode, type TreeSurface } from "./file-preview-nav";
import { usePanelOptional } from "../core/PanelProvider";
import { useWorkspaceTree } from "./useWorkspaceTree";

/** 工作区目录树。侧栏和面包屑下拉是同一套树，只是 surface 不同。 */
export function WorkspaceTree({
  projectId,
  filter,
  activePath,
  onSelectFile,
  onContextMenu,
  surface = "sidebar",
  directoryPath = "",
  sessionId = "",
  initialExpanded = [],
  revealSelectedPath = false,
  openMode = "",
  includeHidden = true,
}: {
  projectId: string;
  filter: string;
  activePath: string;
  onSelectFile: (path: string, intent: { isPreview: true }) => void;
  onContextMenu?: (path: string, event: ReactMouseEvent) => void;
  surface?: TreeSurface;
  directoryPath?: string;
  sessionId?: string;
  initialExpanded?: readonly string[];
  revealSelectedPath?: boolean;
  openMode?: FileOpenMode | "";
  includeHidden?: boolean;
}) {
  const panelSessionId = usePanelOptional()?.sessionId ?? "";
  const tree = useWorkspaceTree(projectId, filter, {
    directoryPath,
    initialExpanded,
    sessionId: sessionId || panelSessionId,
  });
  const activeRef = useRef<HTMLButtonElement | null>(null);
  const rootReady = Boolean(tree.rootEntries);

  useEffect(() => {
    if (!revealSelectedPath || !rootReady) return;
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [revealSelectedPath, rootReady, activePath, tree.expanded]);

  const openFile = (path: string, kind?: string) => {
    const selected = previewSelection(path, kind);
    if (!selected) return;
    onSelectFile(selected.path, { isPreview: true });
  };

  return (
    <div
      data-tree-surface={surface}
      data-directory-path={directoryPath}
      data-include-hidden={includeHidden ? "true" : "false"}
      data-reveal-selected={revealSelectedPath ? "true" : "false"}
      data-open-mode={openMode || undefined}
      data-expand-active={openMode === "workspace" ? "true" : "false"}
    >
      {tree.query ? (
        <FilterTree tree={tree} activePath={activePath} onSelectFile={openFile} onContextMenu={onContextMenu} />
      ) : (
        <DirectoryTree
          tree={tree}
          surface={surface}
          activePath={activePath}
          activeRef={activeRef}
          onSelectFile={openFile}
          onContextMenu={onContextMenu}
        />
      )}
    </div>
  );
}

function FilterTree({
  tree,
  activePath,
  onSelectFile,
  onContextMenu,
}: {
  tree: ReturnType<typeof useWorkspaceTree>;
  activePath: string;
  onSelectFile: (path: string, kind?: string) => void;
  onContextMenu?: (path: string, event: ReactMouseEvent) => void;
}) {
  if (tree.filterError) {
    return <p className="px-2 py-6 text-center text-xs leading-5 text-red-300">{tree.filterError}</p>;
  }
  if (!tree.filtered) {
    return (
      <p className="px-2 py-6 text-center text-xs leading-5 text-zinc-500" data-files-filter-pending>
        {DESKTOP_ZH.filesFilterPending}
      </p>
    );
  }
  if (tree.filtered.paths.length === 0) {
    return <p className="px-2 py-6 text-center text-xs leading-5 text-zinc-500">{DESKTOP_ZH.noFileMatch}</p>;
  }
  const files: FileTreeFile[] = tree.filtered.paths.map((path) => ({ path, added: 0, removed: 0 }));
  return (
    <div data-files-filter-results data-files-filter-ready={tree.filtering ? "false" : "true"}>
      <FileTreeList
        nodes={buildFileTree(files)}
        collapsed={tree.filterCollapsed}
        activePath={activePath}
        rowAttr="data-workspace-file"
        showStats={false}
        onToggle={tree.toggleFilter}
        onSelect={(file) => onSelectFile(file.path, "file")}
        onContextMenu={
          onContextMenu
            ? (file, event) => {
                onContextMenu(file.path, event);
              }
            : undefined
        }
      />
      {tree.filtered.truncated ? (
        <p className="px-2 py-2 text-center text-[11px] text-zinc-500" data-files-filter-cap>
          {DESKTOP_ZH.filesFilterCap}
        </p>
      ) : null}
      {tree.filtering ? (
        <p className="px-2 py-1 text-center text-[11px] text-zinc-500">{DESKTOP_ZH.filesFilterPending}</p>
      ) : null}
    </div>
  );
}

function DirectoryTree({
  tree,
  surface,
  activePath,
  activeRef,
  onSelectFile,
  onContextMenu,
}: {
  tree: ReturnType<typeof useWorkspaceTree>;
  surface: TreeSurface;
  activePath: string;
  activeRef: { current: HTMLButtonElement | null };
  onSelectFile: (path: string, kind?: string) => void;
  onContextMenu?: (path: string, event: ReactMouseEvent) => void;
}) {
  if (tree.rootError) {
    return (
      <p className="px-2 py-6 text-center text-xs leading-5 text-red-300" data-directory-error>
        {surface === "dropdown" ? DESKTOP_ZH.directoryError : tree.rootError}
      </p>
    );
  }
  if (!tree.rootEntries) {
    return (
      <p className="px-2 py-6 text-center text-xs leading-5 text-zinc-500" data-tree-pending>
        {surface === "dropdown" ? DESKTOP_ZH.loadingDirectory : DESKTOP_ZH.filesReading}
      </p>
    );
  }
  if (tree.rootEntries.length === 0) {
    return (
      <p className="px-2 py-6 text-center text-xs leading-5 text-zinc-500" data-directory-empty>
        {surface === "dropdown" ? DESKTOP_ZH.emptyDirectory : DESKTOP_ZH.noFileMatch}
      </p>
    );
  }

  return (
    <ul data-tree-root-count={tree.rootEntries.length}>
      {tree.rootEntries.map((entry) => (
        <TreeRows
          key={entry.path}
          entry={entry}
          depth={0}
          surface={surface}
          cache={tree.cache}
          expanded={tree.expanded}
          errors={tree.errors}
          loading={tree.loading}
          activePath={activePath}
          activeRef={activeRef}
          onToggle={tree.toggle}
          onSelectFile={onSelectFile}
          onContextMenu={onContextMenu}
        />
      ))}
    </ul>
  );
}

function TreeRows({
  entry,
  depth,
  surface,
  cache,
  expanded,
  errors,
  loading,
  activePath,
  activeRef,
  onToggle,
  onSelectFile,
  onContextMenu,
}: {
  entry: TreeEntry;
  depth: number;
  surface: TreeSurface;
  cache: ReadonlyMap<string, TreeEntry[]>;
  expanded: ReadonlySet<string>;
  errors: ReadonlyMap<string, string>;
  loading: ReadonlySet<string>;
  activePath: string;
  activeRef: { current: HTMLButtonElement | null };
  onToggle: (dir: string) => void;
  onSelectFile: (path: string, kind?: string) => void;
  onContextMenu?: (path: string, event: ReactMouseEvent) => void;
}) {
  const pad = { paddingLeft: 4 + depth * 12 };
  if (entry.kind === "dir") {
    const open = expanded.has(entry.path);
    const children = cache.get(entry.path);
    const error = errors.get(entry.path);
    return (
      <li>
        <button
          type="button"
          data-file-dir={entry.path}
          title={entry.path}
          aria-expanded={open}
          style={pad}
          className="flex w-full min-w-0 items-center gap-1 rounded-md py-1 text-left text-[12px] text-[#bdbdbd] hover:bg-white/[0.04]"
          onClick={() => onToggle(entry.path)}
        >
          {open ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
          <span data-dir-path={entry.path} className="min-w-0 flex-1 truncate text-xs">
            {treePathLabel(entry.name)}
          </span>
        </button>
        {open ? (
          <ul>
            {loading.has(entry.path) && !children ? (
              <li className="px-2 py-1 text-[11px] text-zinc-500" style={{ paddingLeft: 16 + depth * 12 }}>
                {surface === "dropdown" ? DESKTOP_ZH.loadingDirectory : DESKTOP_ZH.filesReading}
              </li>
            ) : null}
            {error ? (
              <li className="px-2 py-1 text-[11px] text-red-300" style={{ paddingLeft: 16 + depth * 12 }}>
                {surface === "dropdown" ? DESKTOP_ZH.directoryError : error}
              </li>
            ) : null}
            {children && children.length === 0 ? (
              <li
                className="px-2 py-1 text-[11px] text-zinc-500"
                data-directory-empty
                style={{ paddingLeft: 16 + depth * 12 }}
              >
                {surface === "dropdown" ? DESKTOP_ZH.emptyDirectory : DESKTOP_ZH.emptyFolder}
              </li>
            ) : null}
            {children?.map((child) => (
              <TreeRows
                key={child.path}
                entry={child}
                depth={depth + 1}
                surface={surface}
                cache={cache}
                expanded={expanded}
                errors={errors}
                loading={loading}
                activePath={activePath}
                activeRef={activeRef}
                onToggle={onToggle}
                onSelectFile={onSelectFile}
                onContextMenu={onContextMenu}
              />
            ))}
          </ul>
        ) : null}
      </li>
    );
  }
  const active = entry.path === activePath;
  return (
    <li>
      <button
        type="button"
        ref={
          active
            ? (node) => {
                activeRef.current = node;
              }
            : undefined
        }
        data-workspace-file={entry.path}
        title={entry.path}
        style={pad}
        className={cn(
          "flex w-full min-w-0 items-center gap-1 rounded-md py-1 text-left",
          active ? "bg-[#2a2a2a]" : "hover:bg-white/[0.04]",
        )}
        onClick={() => onSelectFile(entry.path, entry.kind)}
        onContextMenu={
          onContextMenu
            ? (event) => {
                event.preventDefault();
                onContextMenu(entry.path, event);
              }
            : undefined
        }
      >
        <File className="h-3.5 w-3.5 shrink-0 text-[#888]" />
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[#e8e8e8]">{entry.name}</span>
      </button>
    </li>
  );
}
