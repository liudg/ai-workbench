import { useEffect, useMemo, useRef, useState } from "react";

import { backend } from "@/lib/ipc";
import { parseUnifiedDiff, type FileChange } from "@/features/changes-model/diff-parse";
import { usePanel } from "@/features/panel/core/PanelProvider";
import { filterFiles, useFileFilter } from "@/features/panel/files/file-filter";
import { withoutWhitespaceChanges } from "./fold";
import { loadProjectGitDiff } from "./git-diff";

export function useDiffDocument(turnFiles: FileChange[]) {
  const { projectId, openHref } = usePanel();
  const [filter] = useFileFilter();
  const [scope, setScope] = useState("turn");
  const [hideWs, setHideWs] = useState(false);
  const [gitFiles, setGitFiles] = useState<FileChange[] | null>(null);
  const [gitError, setGitError] = useState("");
  const [loading, setLoading] = useState(false);
  const [hidden, setHidden] = useState<string[]>([]);
  const [activePath, setActivePath] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [unified, setUnified] = useState(false);
  const [loadFull, setLoadFull] = useState(true);
  const [renderPreview, setRenderPreview] = useState(false);
  const [wordDiff, setWordDiff] = useState(true);
  const [sources, setSources] = useState<Record<string, string>>({});

  useEffect(() => {
    setHidden([]);
    setActivePath("");
  }, [scope]);

  useEffect(() => {
    if (scope === "turn" || scope === "committed" || scope === "branch") {
      setGitFiles(null);
      setGitError("");
      setLoading(false);
      return;
    }
    let cancel = false;
    setLoading(true);
    setGitError("");
    setGitFiles(null);
    void loadProjectGitDiff(projectId, scope, hideWs)
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
  }, [hideWs, projectId, scope]);

  const listed = useMemo(() => {
    const source = scope === "turn" ? turnFiles : (gitFiles ?? []);
    const visible = source.filter((file) => !hidden.includes(file.path));
    if (scope !== "turn" || !hideWs) return visible;
    return visible.flatMap((file) => {
      const parsed = parseUnifiedDiff(withoutWhitespaceChanges(file.diff)).filter(
        (item) => item.added + item.removed > 0,
      );
      return parsed.map((item) => ({ ...item, status: file.status }));
    });
  }, [gitFiles, hidden, hideWs, scope, turnFiles]);

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
  }, [expanded, loadFull, projectId, renderPreview, sourceKey]);

  const selectFile = (file: FileChange) => {
    setActivePath(file.path);
    document.querySelector(`[data-diff-file-body="${cssEscape(file.path)}"]`)?.scrollIntoView({ block: "nearest" });
  };

  const hideActive = () => {
    if (!active) return;
    setHidden((current) => (current.includes(active.path) ? current : [...current, active.path]));
  };

  return {
    scope,
    setScope,
    hideWs,
    setHideWs,
    loading,
    gitError,
    shown,
    active,
    added,
    removed,
    expanded,
    setExpanded,
    unified,
    setUnified,
    loadFull,
    setLoadFull,
    renderPreview,
    setRenderPreview,
    wordDiff,
    setWordDiff,
    sources,
    selectFile,
    hideActive,
    jump: () => {
      if (!active) return;
      openHref(active.path);
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
