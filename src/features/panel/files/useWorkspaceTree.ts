import { useEffect, useRef, useState } from "react";

import { backend, type TreeEntry } from "@/lib/ipc";

export function useWorkspaceTree(
  projectId: string,
  filter: string,
  options?: { directoryPath?: string; initialExpanded?: readonly string[] },
) {
  const directoryPath = options?.directoryPath ?? "";
  const expandKey = (options?.initialExpanded ?? []).join("\0");
  const [cache, setCache] = useState<ReadonlyMap<string, TreeEntry[]>>(new Map());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [loading, setLoading] = useState<ReadonlySet<string>>(new Set());
  const [filtered, setFiltered] = useState<{ query: string; paths: string[]; truncated: boolean } | null>(null);
  const [filterError, setFilterError] = useState("");
  const [filtering, setFiltering] = useState(false);
  const [filterCollapsed, setFilterCollapsed] = useState<ReadonlySet<string>>(new Set());
  const live = useRef(0);
  const inflight = useRef(new Set<string>());

  useEffect(() => {
    const ticket = ++live.current;
    inflight.current.clear();
    const rootKey = directoryPath;
    const seeds = expandKey ? expandKey.split("\0") : [];
    setCache(new Map());
    setExpanded(new Set(seeds));
    setErrors(new Map());
    setLoading(new Set([rootKey, ...seeds]));

    const remember = (dir: string, entries: TreeEntry[]) => {
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
    };
    const fail = (dir: string, err: unknown) => {
      inflight.current.delete(dir);
      if (live.current !== ticket) return;
      setErrors((current) => new Map(current).set(dir, errorText(err, "无法读取目录")));
      setLoading((current) => {
        const next = new Set(current);
        next.delete(dir);
        return next;
      });
    };
    const load = (dir: string) => {
      if (inflight.current.has(dir)) return;
      inflight.current.add(dir);
      void backend.listProjectDir(projectId, dir).then(
        (entries) => remember(dir, entries),
        (err: unknown) => fail(dir, err),
      );
    };

    load(rootKey);
    for (const dir of seeds) {
      if (dir !== rootKey) load(dir);
    }
    return () => {
      live.current += 1;
    };
  }, [projectId, directoryPath, expandKey]);

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
      void (async () => {
        try {
          for (let hop = 0; hop < 20000; hop += 1) {
            if (cancel) return;
            const result = await backend.filterProjectPaths(projectId, query);
            if (cancel || result.cancelled) return;
            setFiltered({ query, paths: result.paths, truncated: result.truncated });
            if (result.ready !== false) {
              setFiltering(false);
              return;
            }
            await new Promise((resolve) => window.setTimeout(resolve, 40));
          }
          if (!cancel) {
            setFilterError("筛选没有完成");
            setFiltering(false);
          }
        } catch (err: unknown) {
          if (cancel) return;
          setFiltered(null);
          setFilterError(errorText(err, "无法筛选文件"));
          setFiltering(false);
        }
      })();
    }, 80);
    return () => {
      cancel = true;
      window.clearTimeout(timer);
    };
  }, [filter, projectId]);

  const toggleFilter = (id: string) => {
    setFilterCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

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

  const query = filter.trim();
  return {
    query,
    directoryPath,
    filterError,
    filtering,
    filtered: filtered?.query === query ? filtered : null,
    filterCollapsed,
    toggleFilter,
    rootError: errors.get(directoryPath) ?? "",
    rootEntries: cache.get(directoryPath),
    cache,
    expanded,
    errors,
    loading,
    toggle,
  };
}

function errorText(err: unknown, fallback: string): string {
  if (typeof err === "string" && err.trim()) return err;
  if (err instanceof Error && err.message.trim()) return err.message;
  return fallback;
}
