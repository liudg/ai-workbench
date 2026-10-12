import { useMemo, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, File, PanelRightClose } from "lucide-react";

import { cn } from "@/lib/utils";
import type { FileChange } from "@/features/changes-model/diff-parse";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { filterFiles, useFileFilter } from "./file-filter";
import { buildFileTree, treePathLabel, type FileTreeNode } from "./file-tree";

export function ChangesSidebar({
  files,
  activePath,
  rowAttr,
  mark,
  width,
  onSelect,
  onHide,
  empty,
}: {
  files: readonly FileChange[];
  activePath: string;
  rowAttr: "data-diff-file" | "data-session-file";
  mark?: "session" | "diff";
  width?: number;
  onSelect: (file: FileChange) => void;
  onHide?: () => void;
  empty: ReactNode;
}) {
  const [filter, setFilter] = useFileFilter();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const shown = useMemo(() => filterFiles(files, filter), [files, filter]);
  const tree = useMemo(() => buildFileTree(shown), [shown]);

  const toggleDir = (id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <aside
      data-files-sidebar
      data-expanded="true"
      {...(mark === "session" ? { "data-session-files": "" } : {})}
      {...(mark === "diff" ? { "data-diff-files": "" } : {})}
      style={width ? { width, minWidth: width } : undefined}
      className="flex h-full min-h-0 min-w-0 shrink-0 flex-col overflow-hidden border-l border-zinc-800 bg-zinc-950"
    >
      <div className="flex shrink-0 items-center gap-1 border-b border-zinc-800 p-1.5">
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={DESKTOP_ZH.filterFiles}
          aria-label={DESKTOP_ZH.filterFiles}
          data-files-filter
          {...(mark === "diff" ? { "data-diff-filter": "" } : {})}
          className="w-full min-w-0 rounded-md border border-zinc-800 bg-zinc-900 px-1.5 py-1 text-xs text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-zinc-600"
        />
        {onHide ? (
          <button
            type="button"
            data-files-toggle
            title={DESKTOP_ZH.filesHideSidebar}
            aria-label={DESKTOP_ZH.filesHideSidebar}
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-zinc-300 hover:bg-zinc-800 hover:text-zinc-50"
            onClick={onHide}
          >
            <PanelRightClose className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1 py-1">
        {files.length === 0 ? (
          empty
        ) : shown.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs leading-5 text-zinc-500">{DESKTOP_ZH.noFileMatch}</p>
        ) : (
          <ul>
            {tree.map((node) => (
              <TreeRows
                key={node.id}
                node={node}
                depth={0}
                collapsed={collapsed}
                activePath={activePath}
                rowAttr={rowAttr}
                onToggle={toggleDir}
                onSelect={onSelect}
              />
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

function TreeRows({
  node,
  depth,
  collapsed,
  activePath,
  rowAttr,
  onToggle,
  onSelect,
}: {
  node: FileTreeNode<FileChange>;
  depth: number;
  collapsed: ReadonlySet<string>;
  activePath: string;
  rowAttr: "data-diff-file" | "data-session-file";
  onToggle: (id: string) => void;
  onSelect: (file: FileChange) => void;
}) {
  const pad = { paddingLeft: 4 + depth * 12 };
  if (node.kind === "dir") {
    const open = !collapsed.has(node.id);
    return (
      <li>
        <button
          type="button"
          data-file-dir={node.path}
          title={node.path}
          aria-expanded={open}
          style={pad}
          className="flex w-full min-w-0 items-center gap-1 rounded-md py-1 text-left text-zinc-300 hover:bg-zinc-800/80"
          onClick={() => onToggle(node.id)}
        >
          {open ? (
            <ChevronDown className="h-3 w-3 shrink-0" />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0" />
          )}
          <span data-dir-path={node.path} className="min-w-0 flex-1 truncate text-xs">
            {treePathLabel(node.name)}
          </span>
        </button>
        {open ? (
          <ul>
            {node.children.map((child) => (
              <TreeRows
                key={child.id}
                node={child}
                depth={depth + 1}
                collapsed={collapsed}
                activePath={activePath}
                rowAttr={rowAttr}
                onToggle={onToggle}
                onSelect={onSelect}
              />
            ))}
          </ul>
        ) : null}
      </li>
    );
  }
  const file = node.file;
  if (!file) return null;
  const active = file.path === activePath;
  return (
    <li>
      <button
        type="button"
        {...{ [rowAttr]: file.path }}
        data-file-status={file.status}
        title={file.path}
        style={pad}
        className={cn(
          "flex w-full min-w-0 items-center gap-1 rounded-md py-1 text-left",
          active ? "bg-zinc-800" : "hover:bg-zinc-800/80",
        )}
        onClick={() => onSelect(file)}
      >
        <File className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-200">{node.name}</span>
        {file.added > 0 ? (
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-emerald-400">+{file.added}</span>
        ) : null}
        {file.removed > 0 ? (
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-red-400">-{file.removed}</span>
        ) : null}
      </button>
    </li>
  );
}
