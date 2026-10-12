import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Ellipsis,
  ExternalLink,
  ListFilter,
  PanelRightClose,
  RefreshCw,
} from "lucide-react";

import { cn } from "@/lib/utils";
import type { FileChange } from "@/features/changes-model/diff-parse";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { filterFiles, useFileFilter } from "./file-filter";
import { buildFileTree, directoryIds, type FileTreeNode } from "./file-tree";
import { fileStatusTone } from "./path";

export function ChangesSidebar({
  files,
  activePath,
  rowAttr,
  mark,
  width,
  onSelect,
  onJump,
  onRefresh,
  onOpenExternal,
  onHide,
  empty,
}: {
  files: readonly FileChange[];
  activePath: string;
  rowAttr: "data-diff-file" | "data-session-file";
  mark?: "session" | "diff";
  width?: number;
  onSelect: (file: FileChange) => void;
  onJump: () => void;
  onRefresh: () => void;
  onOpenExternal: () => Promise<void> | void;
  onHide: () => void;
  empty: ReactNode;
}) {
  const [filter, setFilter] = useFileFilter();
  const [filterOpen, setFilterOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState("");
  const shown = useMemo(() => filterFiles(files, filter), [files, filter]);
  const tree = useMemo(() => buildFileTree(shown), [shown]);
  const dirs = useMemo(() => directoryIds(tree), [tree]);
  const foldersCollapsed = dirs.length > 0 && dirs.every((id) => collapsed.has(id));

  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menu]);

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
      <div className="flex h-8 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-zinc-800 px-1">
        <div className="relative" ref={menuRef}>
          <IconButton
            action="more"
            label={DESKTOP_ZH.filesMore}
            pressed={menu}
            onClick={() => setMenu((value) => !value)}
          >
            <Ellipsis className="h-3.5 w-3.5" />
          </IconButton>
          {menu ? (
            <div
              role="menu"
              data-files-menu
              className="absolute left-0 top-full z-30 mt-1 w-36 rounded-xl border border-zinc-700 bg-zinc-900 py-1 shadow-lg"
            >
              <button
                type="button"
                role="menuitem"
                className="block w-full px-3 py-1.5 text-left text-xs text-zinc-100 hover:bg-zinc-800"
                onClick={() => {
                  setCollapsed(new Set());
                  setMenu(false);
                }}
              >
                {DESKTOP_ZH.filesExpandFolders}
              </button>
              <button
                type="button"
                role="menuitem"
                className="block w-full px-3 py-1.5 text-left text-xs text-zinc-100 hover:bg-zinc-800"
                onClick={() => {
                  setCollapsed(new Set(dirs));
                  setMenu(false);
                }}
              >
                {DESKTOP_ZH.filesCollapse}
              </button>
            </div>
          ) : null}
        </div>
        <IconButton
          action="collapse"
          label={foldersCollapsed ? DESKTOP_ZH.filesExpandFolders : DESKTOP_ZH.filesCollapse}
          onClick={() => setCollapsed(foldersCollapsed ? new Set() : new Set(dirs))}
        >
          {foldersCollapsed ? (
            <ChevronsUpDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronsDownUp className="h-3.5 w-3.5" />
          )}
        </IconButton>
        <IconButton action="refresh" label={DESKTOP_ZH.filesRefresh} onClick={onRefresh}>
          <RefreshCw className="h-3.5 w-3.5" />
        </IconButton>
        <IconButton action="jump" label={DESKTOP_ZH.diffJump} onClick={onJump}>
          <ArrowUpRight className="h-3.5 w-3.5" />
        </IconButton>
        <IconButton
          action="filter"
          label={DESKTOP_ZH.filterFiles}
          pressed={filterOpen}
          onClick={() => setFilterOpen((value) => !value)}
        >
          <ListFilter className="h-3.5 w-3.5" />
        </IconButton>
        <IconButton
          action="external"
          label={DESKTOP_ZH.filesOpenExternal}
          onClick={() => {
            setError("");
            void Promise.resolve(onOpenExternal()).catch(() => {
              setError(DESKTOP_ZH.filesOpenExternalFailed);
            });
          }}
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </IconButton>
        <IconButton action="hide" label={DESKTOP_ZH.filesHideSidebar} attr="data-files-toggle" onClick={onHide}>
          <PanelRightClose className="h-3.5 w-3.5" />
        </IconButton>
      </div>
      {filterOpen ? (
        <div className="shrink-0 border-b border-zinc-800 p-1.5">
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={DESKTOP_ZH.filterFiles}
            aria-label={DESKTOP_ZH.filterFiles}
            data-files-filter
            {...(mark === "diff" ? { "data-diff-filter": "" } : {})}
            className="w-full min-w-0 rounded-md border border-zinc-800 bg-zinc-900 px-1.5 py-1 text-xs text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-zinc-600"
          />
        </div>
      ) : null}
      {error ? <p className="px-2 py-1 text-[11px] text-red-300">{error}</p> : null}
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
          <span data-dir-path={node.path} className="min-w-0 flex-1 truncate font-mono text-xs">
            {node.name}
          </span>
          <span data-dir-count={node.count} className="shrink-0 font-mono text-[11px] tabular-nums text-zinc-500">
            {node.count}
          </span>
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-emerald-400">+{node.added}</span>
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-red-400">-{node.removed}</span>
        </button>
        {open
          ? node.children.map((child) => (
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
            ))
          : null}
      </li>
    );
  }
  const file = node.file;
  if (!file) return null;
  const active = file.path === activePath;
  const tone = fileStatusTone(file.status);
  return (
    <li>
      <button
        type="button"
        {...{ [rowAttr]: file.path }}
        title={file.path}
        style={pad}
        className={cn(
          "flex w-full min-w-0 items-center gap-1 rounded-md py-1 text-left",
          active ? "bg-zinc-800" : "hover:bg-zinc-800/80",
        )}
        onClick={() => onSelect(file)}
      >
        <span
          data-file-status={file.status}
          className={cn(
            "w-4 shrink-0 text-center font-mono text-[11px]",
            tone === "add" && "text-emerald-400",
            tone === "del" && "text-red-400",
            tone === "neutral" && "text-zinc-400",
          )}
        >
          {file.status}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-200">{node.name}</span>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-emerald-400">+{file.added}</span>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-red-400">-{file.removed}</span>
      </button>
    </li>
  );
}

function IconButton({
  action,
  label,
  pressed,
  attr,
  onClick,
  children,
}: {
  action: string;
  label: string;
  pressed?: boolean;
  attr?: "data-files-toggle";
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      data-files-action={action}
      {...(attr ? { [attr]: "" } : {})}
      className={cn(
        "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-zinc-300 hover:bg-zinc-800 hover:text-zinc-50",
        pressed && "bg-zinc-800 text-zinc-50",
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
