import type React from "react";
import { ChevronDown, ChevronRight, File, Folder, FolderOpen } from "lucide-react";

import { cn } from "@/lib/utils";
import { treePathLabel, type FileTreeFile, type FileTreeNode } from "./file-tree";

export function FileTreeList<T extends FileTreeFile>({
  nodes,
  collapsed,
  activePath,
  rowAttr,
  showStats,
  onToggle,
  onSelect,
  onKeepOpen,
  onContextMenu,
}: {
  nodes: readonly FileTreeNode<T>[];
  collapsed: ReadonlySet<string>;
  activePath: string;
  rowAttr: "data-diff-file" | "data-session-file" | "data-workspace-file";
  showStats: boolean;
  onToggle: (id: string) => void;
  onSelect: (file: T) => void;
  onKeepOpen?: (file: T) => void;
  onContextMenu?: (file: T, event: React.MouseEvent) => void;
}) {
  return (
    <ul className="space-y-0.5">
      {nodes.map((node) => (
        <TreeRows
          key={node.id}
          node={node}
          collapsed={collapsed}
          activePath={activePath}
          rowAttr={rowAttr}
          showStats={showStats}
          onToggle={onToggle}
          onSelect={onSelect}
          onKeepOpen={onKeepOpen}
          onContextMenu={onContextMenu}
        />
      ))}
    </ul>
  );
}

function fileStatus(file: FileTreeFile): string {
  if (!("status" in file)) return "";
  const status = (file as { status?: unknown }).status;
  return typeof status === "string" ? status : "";
}

function fileStatusClass(status: string): string {
  if (status === "A") return "text-wb-diff-add-fg";
  if (status === "D") return "text-wb-diff-del-fg";
  return "text-wb-warn";
}

function TreeRows<T extends FileTreeFile>({
  node,
  collapsed,
  activePath,
  rowAttr,
  showStats,
  onToggle,
  onSelect,
  onKeepOpen,
  onContextMenu,
}: {
  node: FileTreeNode<T>;
  collapsed: ReadonlySet<string>;
  activePath: string;
  rowAttr: "data-diff-file" | "data-session-file" | "data-workspace-file";
  showStats: boolean;
  onToggle: (id: string) => void;
  onSelect: (file: T) => void;
  onKeepOpen?: (file: T) => void;
  onContextMenu?: (file: T, event: React.MouseEvent) => void;
}) {
  if (node.kind === "dir") {
    const open = !collapsed.has(node.id);
    const FolderIcon = open ? FolderOpen : Folder;
    return (
      <li>
        <button
          type="button"
          data-file-dir={node.path}
          title={node.path}
          aria-expanded={open}
          className="flex w-full min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-left text-[12px] text-wb-fg-2 transition-colors hover:bg-wb-hover hover:text-wb-fg"
          onClick={() => onToggle(node.id)}
        >
          {open ? <ChevronDown className="h-3 w-3 shrink-0 text-wb-fg-3" /> : <ChevronRight className="h-3 w-3 shrink-0 text-wb-fg-3" />}
          <FolderIcon className="h-3.5 w-3.5 shrink-0 text-wb-fg-3" strokeWidth={1.75} aria-hidden="true" />
          <span data-dir-path={node.path} className="min-w-0 flex-1 truncate text-xs font-medium text-wb-fg">
            {treePathLabel(node.name)}
          </span>
          {showStats && node.count > 0 ? (
            <span className="shrink-0 px-1 text-xs tabular-nums text-wb-group-fg">
              {node.count}
            </span>
          ) : null}
        </button>
        {open ? (
          <ul className="ml-2.5 mt-0.5 space-y-0.5 border-l border-wb-border-strong pl-2">
            {node.children.map((child) => (
              <TreeRows
                key={child.id}
                node={child}
                collapsed={collapsed}
                activePath={activePath}
                rowAttr={rowAttr}
                showStats={showStats}
                onToggle={onToggle}
                onSelect={onSelect}
                onKeepOpen={onKeepOpen}
                onContextMenu={onContextMenu}
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
  const status = fileStatus(file);
  return (
    <li>
      <button
        type="button"
        {...{ [rowAttr]: file.path }}
        {...(status ? { "data-file-status": status } : {})}
        title={file.path}
        className={cn(
          "flex w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left transition-colors",
          active ? "wb-menu-active font-medium" : "hover:bg-wb-hover",
        )}
        onClick={() => onSelect(file)}
        onDoubleClick={onKeepOpen ? () => onKeepOpen(file) : undefined}
        onContextMenu={
          onContextMenu
            ? (event) => {
                event.preventDefault();
                onContextMenu(file, event);
              }
            : undefined
        }
      >
        <File className={cn("h-3.5 w-3.5 shrink-0", active ? "text-wb-accent-ink" : "text-wb-fg-3")} />
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-wb-fg">{node.name}</span>
        {showStats && status ? (
          <span className={cn("shrink-0 font-mono text-xs font-semibold", fileStatusClass(status))}>
            {status}
          </span>
        ) : null}
        {showStats && file.added > 0 ? (
          <span className="shrink-0 font-mono text-xs tabular-nums text-wb-diff-add-fg">+{file.added}</span>
        ) : null}
        {showStats && file.removed > 0 ? (
          <span className="shrink-0 font-mono text-xs tabular-nums text-wb-diff-del-fg">-{file.removed}</span>
        ) : null}
      </button>
    </li>
  );
}
