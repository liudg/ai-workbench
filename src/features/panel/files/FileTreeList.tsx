import { ChevronDown, ChevronRight, File } from "lucide-react";

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
}: {
  nodes: readonly FileTreeNode<T>[];
  collapsed: ReadonlySet<string>;
  activePath: string;
  rowAttr: "data-diff-file" | "data-session-file" | "data-workspace-file";
  showStats: boolean;
  onToggle: (id: string) => void;
  onSelect: (file: T) => void;
}) {
  return (
    <ul>
      {nodes.map((node) => (
        <TreeRows
          key={node.id}
          node={node}
          depth={0}
          collapsed={collapsed}
          activePath={activePath}
          rowAttr={rowAttr}
          showStats={showStats}
          onToggle={onToggle}
          onSelect={onSelect}
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

function TreeRows<T extends FileTreeFile>({
  node,
  depth,
  collapsed,
  activePath,
  rowAttr,
  showStats,
  onToggle,
  onSelect,
}: {
  node: FileTreeNode<T>;
  depth: number;
  collapsed: ReadonlySet<string>;
  activePath: string;
  rowAttr: "data-diff-file" | "data-session-file" | "data-workspace-file";
  showStats: boolean;
  onToggle: (id: string) => void;
  onSelect: (file: T) => void;
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
          {open ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
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
                showStats={showStats}
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
        {...(fileStatus(file) ? { "data-file-status": fileStatus(file) } : {})}
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
        {showStats && file.added > 0 ? (
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-emerald-400">+{file.added}</span>
        ) : null}
        {showStats && file.removed > 0 ? (
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-red-400">-{file.removed}</span>
        ) : null}
      </button>
    </li>
  );
}
