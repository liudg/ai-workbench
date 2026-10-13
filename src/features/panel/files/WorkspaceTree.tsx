import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { ChevronDown, ChevronRight, File } from "lucide-react";

import { backend, type TreeEntry } from "@/lib/ipc";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { cn } from "@/lib/utils";
import { FileTreeList } from "./FileTreeList";
import { buildFileTree, treePathLabel, type FileTreeFile } from "./file-tree";

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
  const [cache, setCache] = useState<ReadonlyMap<string, TreeEntry[]>>(new Map());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [loading, setLoading] = useState<ReadonlySet<string>>(new Set());
  const [filtered, setFiltered] = useState<{ query: string; paths: string[]; truncated: boolean } | null>(
    null,
  );
  const [filterError, setFilterError] = useState("");
  const [filtering, setFiltering] = useState(false);
  const [filterCollapsed, setFilterCollapsed] = useState<ReadonlySet<string>>(new Set());
  const live = useRef(0);
  const inflight = useRef(new Set<string>());

  useEffect(() => {
    const ticket = ++live.current;
    inflight.current.clear();
    setCache(new Map());
    setExpanded(new Set());
    setErrors(new Map());
    setLoading(new Set([""]));
    void backend.listProjectDir(projectId, "").then(
      (entries) => {
        if (live.current !== ticket) return;
        setCache(new Map([["", entries]]));
        setLoading(new Set());
      },
      (err: unknown) => {
        if (live.current !== ticket) return;
        setErrors(new Map([["", errorText(err, "无法读取目录")]]));
        setLoading(new Set());
      },
    );
    return () => {
      live.current += 1;
    };
  }, [projectId]);

  useEffect(() => {
    const query = filter.trim();
    if (!query) {
      setFiltered(null);
      setFilterError("");
      setFiltering(false);
      return;
    }
    let cancel = false;
    setFiltering(true);
    setFilterError("");
    const timer = window.setTimeout(() => {
      void backend.filterProjectPaths(projectId, query).then(
        (result) => {
          if (cancel) return;
          if (result.cancelled) return;
          setFiltered({ query, paths: result.paths, truncated: result.truncated });
          setFiltering(false);
        },
        (err: unknown) => {
          if (cancel) return;
          setFiltered(null);
          setFilterError(errorText(err, "无法筛选文件"));
          setFiltering(false);
        },
      );
    }, 200);
    return () => {
      cancel = true;
      window.clearTimeout(timer);
    };
  }, [filter, projectId]);

  const query = filter.trim();
  if (query) {
    const ready = filtered?.query === query ? filtered : null;
    if (filterError) {
      return <p className="px-2 py-6 text-center text-xs leading-5 text-red-300">{filterError}</p>;
    }
    if (!ready) {
      return (
        <p className="px-2 py-6 text-center text-xs leading-5 text-zinc-500" data-files-filter-pending>
          {DESKTOP_ZH.filesFilterPending}
        </p>
      );
    }
    if (ready.paths.length === 0) {
      return <p className="px-2 py-6 text-center text-xs leading-5 text-zinc-500">{DESKTOP_ZH.noFileMatch}</p>;
    }
    const files: FileTreeFile[] = ready.paths.map((path) => ({ path, added: 0, removed: 0 }));
    return (
      <div data-files-filter-results>
        <FileTreeList
          nodes={buildFileTree(files)}
          collapsed={filterCollapsed}
          activePath={activePath}
          rowAttr="data-workspace-file"
          showStats={false}
          onToggle={(id) => {
            setFilterCollapsed((current) => {
              const next = new Set(current);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            });
          }}
          onSelect={(file) => onSelect(file.path)}
          onContextMenu={(file, event) => onContextMenu(file.path, event)}
        />
        {ready.truncated ? (
          <p className="px-2 py-2 text-center text-[11px] text-zinc-500" data-files-filter-cap>
            {DESKTOP_ZH.filesFilterCap}
          </p>
        ) : null}
        {filtering ? (
          <p className="px-2 py-1 text-center text-[11px] text-zinc-500">{DESKTOP_ZH.filesFilterPending}</p>
        ) : null}
      </div>
    );
  }

  const rootError = errors.get("");
  if (rootError) {
    return <p className="px-2 py-6 text-center text-xs leading-5 text-red-300">{rootError}</p>;
  }
  const rootEntries = cache.get("");
  if (!rootEntries) {
    return (
      <p className="px-2 py-6 text-center text-xs leading-5 text-zinc-500" data-tree-pending>
        {DESKTOP_ZH.filesReading}
      </p>
    );
  }
  if (rootEntries.length === 0) {
    return <p className="px-2 py-6 text-center text-xs leading-5 text-zinc-500">{DESKTOP_ZH.noFileMatch}</p>;
  }

  const toggle = (dir: string) => {
    const willOpen = !expanded.has(dir);
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });
    if (!willOpen || cache.has(dir) || inflight.current.has(dir)) return;
    const ticket = live.current;
    inflight.current.add(dir);
    setLoading((current) => new Set(current).add(dir));
    void backend.listProjectDir(projectId, dir).then(
      (entries) => {
        inflight.current.delete(dir);
        if (live.current !== ticket) return;
        setCache((current) => {
          const next = new Map(current);
          next.set(dir, entries);
          return next;
        });
        setErrors((current) => {
          if (!current.has(dir)) return current;
          const next = new Map(current);
          next.delete(dir);
          return next;
        });
        setLoading((current) => {
          const next = new Set(current);
          next.delete(dir);
          return next;
        });
      },
      (err: unknown) => {
        inflight.current.delete(dir);
        if (live.current !== ticket) return;
        setErrors((current) => new Map(current).set(dir, errorText(err, "无法读取目录")));
        setLoading((current) => {
          const next = new Set(current);
          next.delete(dir);
          return next;
        });
      },
    );
  };

  return (
    <ul data-tree-root-count={rootEntries.length}>
      {rootEntries.map((entry) => (
        <TreeRows
          key={entry.path}
          entry={entry}
          depth={0}
          cache={cache}
          expanded={expanded}
          errors={errors}
          loading={loading}
          activePath={activePath}
          onToggle={toggle}
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
          className="flex w-full min-w-0 items-center gap-1 rounded-md py-1 text-left text-zinc-300 hover:bg-zinc-800/80"
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
          active ? "bg-zinc-800" : "hover:bg-zinc-800/80",
        )}
        onClick={() => onSelect(entry.path)}
        onContextMenu={(event) => {
          event.preventDefault();
          onContextMenu(entry.path, event);
        }}
      >
        <File className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-200">{entry.name}</span>
      </button>
    </li>
  );
}

function errorText(err: unknown, fallback: string): string {
  if (typeof err === "string" && err.trim()) return err;
  if (err instanceof Error && err.message.trim()) return err.message;
  return fallback;
}
