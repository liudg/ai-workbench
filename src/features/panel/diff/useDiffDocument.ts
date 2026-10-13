import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { backend, type DiffScope } from "@/lib/ipc";
import { parseUnifiedDiff, type FileChange } from "@/features/changes-model/diff-parse";
import { usePanel } from "@/features/panel/core/PanelProvider";
import { filterFiles, useFileFilter } from "@/features/panel/files/file-filter";
import { patchFromFiles } from "./git-apply";
import { withoutWhitespaceChanges } from "./fold";
import { diffScopeMenu, filesForScope } from "./scope";

export function useDiffDocument(turnFiles: FileChange[]) {
  const { projectId, sessionId, changes } = usePanel();
  const [filter] = useFileFilter();
  const [scope, setScope] = useState("turn");
  const [hideWs, setHideWs] = useState(false);
  const [provided, setProvided] = useState<DiffScope[]>([]);
  const [gitFiles, setGitFiles] = useState<FileChange[] | null>(null);
  const [gitError, setGitError] = useState("");
  const [loading, setLoading] = useState(false);
  const [activePath, setActivePath] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [loadFull, setLoadFull] = useState(true);
  const [renderPreview, setRenderPreview] = useState(true);
  const [wordDiff, setWordDiff] = useState(true);
  const [wrap, setWrap] = useState(true);
  const [hideImports, setHideImports] = useState(false);
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

  const scopes = useMemo(() => diffScopeMenu(provided, changes), [changes, provided]);
  const selected = scopes.find((item) => item.id === scope && !item.submenu) ?? scopes.find((item) => !item.submenu);

  useEffect(() => {
    if (!selected || selected.id === scope) return;
    setScope(selected.id);
  }, [scope, selected]);

  useEffect(() => {
    setActivePath("");
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
      .diffForScope(sessionId, selected.id, hideWs)
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
  }, [hideWs, remote, reloadToken, selected, sessionId]);

  const base = useMemo(
    () => filesForScope(selected, turnFiles, gitFiles),
    [gitFiles, selected, turnFiles],
  );
  const listed = useMemo(() => {
    const turn = !selected || selected.source === "turn";
    if (!turn || !hideWs) return base;
    return base.flatMap((file) => {
      const parsed = parseUnifiedDiff(withoutWhitespaceChanges(file.diff)).filter(
        (item) => item.added + item.removed > 0,
      );
      return parsed.map((item) => ({ ...item, status: file.status }));
    });
  }, [base, hideWs, selected]);
  const patch = useMemo(() => patchFromFiles(base), [base]);

  const shown = useMemo(() => filterFiles(listed, filter), [filter, listed]);
  const active = shown.find((file) => file.path === activePath) ?? shown[0];
  const added = shown.reduce((sum, file) => sum + file.added, 0);
  const removed = shown.reduce((sum, file) => sum + file.removed, 0);

  const sourceKey = shown.map((file) => file.path).join("\n");
  const triedSource = useRef(new Set<string>());
  useEffect(() => {
    if (!loadFull || (!expanded && !renderPreview)) return;
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
  }, [expanded, loadFull, projectId, reloadToken, renderPreview, sourceKey]);

  const selectFile = useCallback((file: FileChange) => {
    setActivePath(file.path);
    const escaped = cssEscape(file.path);
    document.querySelector(`[data-diff-file-body="${escaped}"]`)?.scrollIntoView({ block: "center" });
    document.querySelector(`[data-diff-file="${escaped}"]`)?.scrollIntoView({ block: "nearest" });
  }, []);

  return {
    scope: selected?.id ?? scope,
    scopes,
    setScope,
    hideWs,
    setHideWs,
    loading,
    gitError,
    shown,
    listed,
    active,
    added,
    removed,
    expanded,
    setExpanded,
    loadFull,
    setLoadFull,
    renderPreview,
    setRenderPreview,
    wordDiff,
    setWordDiff,
    wrap,
    setWrap,
    hideImports,
    setHideImports,
    sources,
    patch,
    selectFile,
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

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/["\\]/g, "\\$&");
}
