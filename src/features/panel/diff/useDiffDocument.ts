import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { backend, type DiffScope } from "@/lib/ipc";
import { parseUnifiedDiff, type FileChange } from "@/features/changes-model/diff-parse";
import { usePanel } from "@/features/panel/core/PanelProvider";
import { filterFiles, useFileFilter } from "../core/file-filter";
import { browserDiffMenuStorage, readDiffMenuOptions, writeDiffMenuOptions, type DiffMenuOptions } from "./diff-menu-options";
import { patchFromFiles } from "./git-apply";
import { pathsWithFileOpen, scrollDiffFileIntoView } from "./reveal-file";
import { diffScopeMenu, filesForScope } from "./scope";

export function useDiffDocument(turnFiles: FileChange[]) {
  const { projectId, sessionId, changes } = usePanel();
  const [filter] = useFileFilter();
  const [scope, setScope] = useState("turn");
  const [menuOptions, setMenuOptions] = useState(() => readDiffMenuOptions(browserDiffMenuStorage()));
  const [provided, setProvided] = useState<DiffScope[]>([]);
  const [gitFiles, setGitFiles] = useState<FileChange[] | null>(null);
  const [gitError, setGitError] = useState("");
  const [loading, setLoading] = useState(false);
  const [activePath, setActivePath] = useState("");
  const [openPaths, setOpenPaths] = useState<string[]>([]);
  const [wrap, setWrap] = useState(true);
  const scrollPath = useRef<string | null>(null);
  const [scrollTick, setScrollTick] = useState(0);
  const [sources, setSources] = useState<Record<string, string>>({});
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancel = false;
    void backend
      .diffScopes(sessionId)
      .then((rows) => {
        if (!cancel) setProvided(rows);
      })
      .catch(() => {
        if (!cancel) setProvided([]);
      });
    return () => {
      cancel = true;
    };
  }, [sessionId]);

  useEffect(() => {
    writeDiffMenuOptions(menuOptions, browserDiffMenuStorage());
  }, [menuOptions]);

  const setMenuFlag = useCallback((key: keyof DiffMenuOptions, value: boolean | ((current: boolean) => boolean)) => {
    setMenuOptions((current) => {
      const next = typeof value === "function" ? value(current[key]) : value;
      return next === current[key] ? current : { ...current, [key]: next };
    });
  }, []);
  const { loadFull, renderPreview, wordDiff, hideWhitespace: hideWs, hideImports } = menuOptions;

  const scopes = useMemo(() => diffScopeMenu(provided, changes), [changes, provided]);
  const selected = scopes.find((item) => item.id === scope && !item.submenu) ?? scopes.find((item) => !item.submenu);

  useEffect(() => {
    if (!selected || selected.id === scope) return;
    setScope(selected.id);
  }, [scope, selected]);

  useEffect(() => {
    setActivePath("");
    setOpenPaths([]);
  }, [scope]);

  const remote = Boolean(selected && selected.source !== "turn" && !selected.submenu);
  useEffect(() => {
    if (!remote || !selected) {
      setGitFiles(null);
      setGitError("");
      setLoading(false);
      return;
    }
    let cancel = false;
    setLoading(true);
    setGitError("");
    setGitFiles(null);
    void backend
      .diffForScope(sessionId, selected.id, false)
      .then((diff) => {
        if (cancel) return;
        setGitFiles(parseUnifiedDiff(diff));
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (cancel) return;
        setGitFiles([]);
        setGitError(errorText(error));
        setLoading(false);
      });
    return () => {
      cancel = true;
    };
  }, [remote, reloadToken, selected, sessionId]);

  const base = useMemo(
    () => filesForScope(selected, turnFiles, gitFiles),
    [gitFiles, selected, turnFiles],
  );
  const listed = base;
  const patch = useMemo(() => patchFromFiles(base), [base]);

  const shown = useMemo(() => filterFiles(listed, filter), [filter, listed]);
  const active = shown.find((file) => file.path === activePath) ?? shown[0];
  const added = shown.reduce((sum, file) => sum + file.added, 0);
  const removed = shown.reduce((sum, file) => sum + file.removed, 0);

  const openSet = useMemo(() => new Set(openPaths), [openPaths]);
  const allExpanded = shown.length > 0 && shown.every((file) => openSet.has(file.path));
  const sourceKey = shown.map((file) => file.path).join("\n");
  const triedSource = useRef(new Set<string>());
  useEffect(() => {
    if (!loadFull || (openPaths.length === 0 && !renderPreview)) return;
    for (const path of sourceKey.split("\n")) {
      if (!path || triedSource.current.has(path)) continue;
      triedSource.current.add(path);
      void backend
        .readPreviewFile(projectId, path)
        .then((doc) => {
          if (doc.kind === "binary") return;
          setSources((current) =>
            Object.prototype.hasOwnProperty.call(current, path) ? current : { ...current, [path]: doc.text },
          );
        })
        .catch(() => {});
    }
  }, [loadFull, openPaths.length, projectId, reloadToken, renderPreview, sourceKey]);

  const queueScroll = useCallback((path: string) => {
    scrollPath.current = path;
    setScrollTick((value) => value + 1);
  }, []);

  useLayoutEffect(() => {
    const path = scrollPath.current;
    if (!path) return;
    scrollPath.current = null;
    scrollDiffFileIntoView(path);
  }, [scrollTick]);

  const selectFile = useCallback((file: FileChange) => {
    setActivePath(file.path);
    queueScroll(file.path);
  }, [queueScroll]);

  const revealFile = useCallback((file: FileChange) => {
    setActivePath(file.path);
    setOpenPaths((current) => {
      const next = pathsWithFileOpen(current, file.path);
      return next === current ? current : [...next];
    });
    queueScroll(file.path);
  }, [queueScroll]);

  return {
    scope: selected?.id ?? scope,
    scopes,
    setScope,
    hideWs,
    setHideWs: (value: boolean | ((current: boolean) => boolean)) => setMenuFlag("hideWhitespace", value),
    loading,
    gitError,
    shown,
    listed,
    active,
    added,
    removed,
    expanded: allExpanded,
    expandAll: (paths: string[]) => setOpenPaths(paths),
    collapseAll: () => setOpenPaths([]),
    toggleFile: (path: string) =>
      setOpenPaths((current) =>
        current.includes(path) ? current.filter((item) => item !== path) : [...current, path],
      ),
    isOpen: (path: string) => openSet.has(path),
    loadFull,
    setLoadFull: (value: boolean | ((current: boolean) => boolean)) => setMenuFlag("loadFull", value),
    renderPreview,
    setRenderPreview: (value: boolean | ((current: boolean) => boolean)) => setMenuFlag("renderPreview", value),
    wordDiff,
    setWordDiff: (value: boolean | ((current: boolean) => boolean)) => setMenuFlag("wordDiff", value),
    wrap,
    setWrap,
    hideImports,
    setHideImports: (value: boolean | ((current: boolean) => boolean)) => setMenuFlag("hideImports", value),
    sources,
    patch,
    selectFile,
    revealFile,
    reload: () => {
      triedSource.current.clear();
      setSources({});
      setReloadToken((value) => value + 1);
    },
  };
}

function errorText(error: unknown): string {
  if (typeof error === "string" && error.trim()) return error;
  if (error instanceof Error && error.message.trim()) return error.message;
  return "无法读取差异";
}
