import type { MouseEvent as ReactMouseEvent } from "react";
import { ChevronDown, ChevronRight, File } from "lucide-react";

import type { TreeEntry } from "@/lib/ipc";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { cn } from "@/lib/utils";
import { FileTreeList } from "./FileTreeList";
import { buildFileTree, treePathLabel, type FileTreeFile } from "./file-tree";
import { useWorkspaceTree } from "./useWorkspaceTree";

/** 右侧工作区树。根目录一次列全；子目录展开时再读。筛选走后端，避免只滤已经展开的那一层。 */
export function WorkspaceTree({
  projectId,
  filter,
  activePath,
  onSelect,
  onContextMenu,
}: {
  projectId: string;
  filter: string;
  activePath: string;
  onSelect: (path: string) => void;
  onContextMenu: (path: string, event: ReactMouseEvent) => void;
}) {
  const tree = useWorkspaceTree(projectId, filter);

  if (tree.query) {
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
          onSelect={(file) => onSelect(file.path)}
          onContextMenu={(file, event) => onContextMenu(file.path, event)}
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

  if (tree.rootError) {
    return <p className="px-2 py-6 text-center text-xs leading-5 text-red-300">{tree.rootError}</p>;
  }
  if (!tree.rootEntries) {
    return (
      <p className="px-2 py-6 text-center text-xs leading-5 text-zinc-500" data-tree-pending>
        {DESKTOP_ZH.filesReading}
      </p>
    );
  }
  if (tree.rootEntries.length === 0) {
    return <p className="px-2 py-6 text-center text-xs leading-5 text-zinc-500">{DESKTOP_ZH.noFileMatch}</p>;
  }

  return (
    <ul data-tree-root-count={tree.rootEntries.length}>
      {tree.rootEntries.map((entry) => (
        <TreeRows
          key={entry.path}
          entry={entry}
          depth={0}
          cache={tree.cache}
          expanded={tree.expanded}
          errors={tree.errors}
          loading={tree.loading}
          activePath={activePath}
          onToggle={tree.toggle}
          onSelect={onSelect}
          onContextMenu={onContextMenu}
        />
      ))}
    </ul>
  );
}

function TreeRows({
  entry,
  depth,
  cache,
  expanded,
  errors,
  loading,
  activePath,
  onToggle,
  onSelect,
  onContextMenu,
}: {
  entry: TreeEntry;
  depth: number;
  cache: ReadonlyMap<string, TreeEntry[]>;
  expanded: ReadonlySet<string>;
  errors: ReadonlyMap<string, string>;
  loading: ReadonlySet<string>;
  activePath: string;
  onToggle: (dir: string) => void;
  onSelect: (path: string) => void;
  onContextMenu: (path: string, event: ReactMouseEvent) => void;
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
                {DESKTOP_ZH.filesReading}
              </li>
            ) : null}
            {error ? (
              <li className="px-2 py-1 text-[11px] text-red-300" style={{ paddingLeft: 16 + depth * 12 }}>
                {error}
              </li>
            ) : null}
            {children && children.length === 0 ? (
              <li className="px-2 py-1 text-[11px] text-zinc-500" style={{ paddingLeft: 16 + depth * 12 }}>
                {DESKTOP_ZH.emptyFolder}
              </li>
            ) : null}
            {children?.map((child) => (
              <TreeRows
                key={child.path}
                entry={child}
                depth={depth + 1}
                cache={cache}
                expanded={expanded}
                errors={errors}
                loading={loading}
                activePath={activePath}
                onToggle={onToggle}
                onSelect={onSelect}
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
        data-workspace-file={entry.path}
        title={entry.path}
        style={pad}
        className={cn(
          "flex w-full min-w-0 items-center gap-1 rounded-md py-1 text-left",
          active ? "bg-[#2a2a2a]" : "hover:bg-white/[0.04]",
        )}
        onClick={() => onSelect(entry.path)}
        onContextMenu={(event) => {
          event.preventDefault();
          onContextMenu(entry.path, event);
        }}
      >
        <File className="h-3.5 w-3.5 shrink-0 text-[#888]" />
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[#e8e8e8]">{entry.name}</span>
      </button>
    </li>
  );
}
