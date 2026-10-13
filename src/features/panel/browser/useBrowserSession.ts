import { useCallback, useEffect, useRef, useState } from "react";

import { convertFileSrc } from "@tauri-apps/api/core";

import { backend, isTauri } from "@/lib/ipc";
import { useWorkbench } from "@/store";
import type { PageAnnotation } from "@/types";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { tabTitleFromDocument } from "./annotate";
import {
  canGoBack,
  canGoForward,
  currentEntry,
  displayFileAddress,
  emptyHistory,
  entryToRestore,
  goBack,
  goForward,
  noteLoaded,
  pageTitleFromHtml,
  parseAddressInput,
  visit,
  type BrowserHistory,
} from "./browser";

const EMPTY_HISTORY = emptyHistory();

export function useBrowserSession({
  tabId,
  projectId,
  sessionId,
  path,
  initialUrl,
  text,
  onTitle,
}: {
  tabId: string;
  projectId: string;
  sessionId: string;
  path: string;
  initialUrl?: string;
  text: string;
  onTitle: (title: string) => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const history = useWorkbench((s) => s.panelBySession[sessionId]?.histories[tabId] ?? EMPTY_HISTORY);
  const [draft, setDraft] = useState<string | null>(null);
  const [annotating, setAnnotating] = useState(false);
  const [snapshotFailed, setSnapshotFailed] = useState(false);
  const [frameKey, setFrameKey] = useState(0);
  const [error, setError] = useState("");
  const [native, setNative] = useState(isTauri);
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;
  const historyRef = useRef(history);
  historyRef.current = history;
  const annotatingRef = useRef(annotating);
  annotatingRef.current = annotating;
  const liveTitle = useRef(false);
  const sentAnnotations = useRef(new Set<string>());

  const commit = useCallback(
    (next: BrowserHistory) => {
      historyRef.current = next;
      useWorkbench.getState().panelRememberHistory(sessionId, tabId, next);
    },
    [sessionId, tabId],
  );

  const placeNative = useCallback(async (target: string) => {
    const node = viewport.current;
    if (!node || !isTauri) return;
    const rect = node.getBoundingClientRect();
    if (!target || rect.width < 8 || rect.height < 8) return;
    await backend.browserShow(target, rect.left, rect.top, rect.width, rect.height);
  }, []);

  const openTarget = useCallback(
    async (entry: { address: string; target: string }, mode: "visit" | "replace") => {
      setError("");
      const next =
        mode === "visit" ? visit(historyRef.current, entry) : replaceCurrent(historyRef.current, entry);
      commit(next);
      if (!isTauri || !native) return;
      try {
        await placeNative(entry.target);
        if (annotatingRef.current) await backend.browserAnnotate(true);
      } catch (err) {
        setNative(false);
        setError(message(err, DESKTOP_ZH.browserOpenFailed));
      }
    },
    [commit, native, placeNative],
  );

  useEffect(() => {
    liveTitle.current = false;
  }, [path, tabId]);

  useEffect(() => {
    if (liveTitle.current) return;
    const title = tabTitleFromDocument(pageTitleFromHtml(text));
    if (title) onTitle(title);
  }, [onTitle, text]);

  const openedFile = useRef("");
  const openedRemote = useRef("");
  useEffect(() => {
    if (path || !initialUrl || openedRemote.current === initialUrl) return;
    openedRemote.current = initialUrl;
    void openTarget({ address: initialUrl, target: initialUrl }, "visit");
  }, [initialUrl, openTarget, path]);

  useEffect(() => {
    if (!path) return;
    const address = displayFileAddress(path);
    const key = `${projectId}\n${address}`;
    if (openedFile.current === key) return;
    const restored = entryToRestore(historyRef.current);
    if (restored) {
      openedFile.current = key;
      void openTarget({ address: restored.address, target: restored.target }, "visit");
      return;
    }
    let cancel = false;
    void preparedFile(projectId, path)
      .then((file) => {
        if (cancel) return;
        openedFile.current = key;
        return openTarget(file, "visit");
      })
      .catch((err: unknown) => {
        if (cancel) return;
        openedFile.current = "";
        setError(message(err, DESKTOP_ZH.browserOpenFailed));
      });
    return () => {
      cancel = true;
    };
  }, [openTarget, path, projectId]);

  useEffect(() => {
    if (!isTauri) return;
    const unlisten = backend.onBrowserNotice((notice) => {
      if (notice.kind === "title") {
        const title = tabTitleFromDocument(notice.value);
        if (title) {
          liveTitle.current = true;
          onTitle(title);
        }
      }
      if (notice.kind === "load") {
        const next = noteLoaded(historyRef.current, notice.value);
        if (next !== historyRef.current) commit(next);
        const target = currentEntry(historyRef.current)?.target ?? "";
        if (target) void placeNative(target).catch(() => setNative(false));
        if (annotatingRef.current) void backend.browserAnnotate(true);
      }
      if (notice.kind === "annotate") {
        setAnnotating(notice.value === "1");
      }
      if (notice.kind === "annotation") {
        try {
          const note = JSON.parse(notice.value) as PageAnnotation;
          if (!note.id || !note.comment.trim()) return;
          if (sentAnnotations.current.has(note.id)) return;
          sentAnnotations.current.add(note.id);
          setSnapshotFailed(Boolean(note.snapshotFailed));
          const sid = sessionRef.current;
          if (!sid) {
            setError(DESKTOP_ZH.browserAnnotateFailed);
            return;
          }
          void backend.submitAnnotation(sid, note).catch(() => {
            setError(DESKTOP_ZH.browserAnnotateFailed);
          });
        } catch {
          setError(DESKTOP_ZH.browserAnnotateFailed);
        }
      }
    });
    return unlisten;
  }, [commit, onTitle, placeNative]);

  useEffect(() => {
    if (!isTauri || !native) return;
    const node = viewport.current;
    if (!node) return;
    let last = "";
    let frame = 0;
    const sync = () => {
      const rect = node.getBoundingClientRect();
      const target = currentEntry(historyRef.current)?.target ?? "";
      if (rect.width < 8 || rect.height < 8 || !target) return;
      const key = `${Math.round(rect.left)}:${Math.round(rect.top)}:${Math.round(rect.width)}:${Math.round(rect.height)}:${target}`;
      if (key === last) return;
      last = key;
      void placeNative(target).catch(() => setNative(false));
    };
    let frames = 0;
    const tick = () => {
      sync();
      frames += 1;
      if (frames < 30) frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    const observer = new ResizeObserver(() => {
      last = "";
      sync();
    });
    observer.observe(node);
    window.addEventListener("resize", sync);
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", sync);
      void backend.browserHide();
    };
  }, [native, placeNative]);

  const shown = draft ?? currentEntry(history)?.address ?? (path ? displayFileAddress(path) : "");
  const frameTarget = currentEntry(history)?.target ?? "";
  const localFrame =
    frameTarget.startsWith("http://asset.localhost/") || frameTarget.startsWith("https://asset.localhost/");
  const frameTargetRef = useRef(frameTarget);
  frameTargetRef.current = frameTarget;

  const toggleAnnotate = useCallback(() => {
    if (!frameTargetRef.current) return;
    const next = !annotatingRef.current;
    setAnnotating(next);
    if (isTauri && native) {
      void backend.browserAnnotate(next).catch(() => {
        setError(DESKTOP_ZH.browserAnnotateFailed);
      });
    }
  }, [native]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.altKey) return;
      if (event.code !== "Period") return;
      if (!frameTargetRef.current || !currentEntry(historyRef.current)?.loaded) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("textarea, input") && !target.closest("[data-browser]")) return;
      event.preventDefault();
      toggleAnnotate();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleAnnotate]);

  const submit = (value: string) => {
    const plan = parseAddressInput(value);
    setDraft(null);
    if (plan.kind === "invalid") {
      setError(DESKTOP_ZH.browserOpenFailed);
      return;
    }
    if (plan.kind === "navigate") {
      void openTarget({ address: plan.address, target: plan.target }, "visit");
      return;
    }
    void preparedFile(projectId, plan.path)
      .then((file) => openTarget(file, "visit"))
      .catch((err: unknown) => setError(message(err, DESKTOP_ZH.browserOpenFailed)));
  };

  const go = (direction: "back" | "forward") => {
    const next = direction === "back" ? goBack(history) : goForward(history);
    if (next === history) return;
    const entry = currentEntry(next);
    commit(next);
    if (!entry) return;
    if (isTauri && native) {
      void placeNative(entry.target).catch(() => setNative(false));
    }
  };

  const reload = () => {
    if (isTauri && native) void backend.browserReload();
    else setFrameKey((key) => key + 1);
  };

  const onFrameLoad = () => {
    const current = currentEntry(historyRef.current);
    if (!current || current.loaded) return;
    const entries = historyRef.current.entries.slice();
    entries[historyRef.current.index] = { ...current, loaded: true };
    commit({ ...historyRef.current, entries });
  };

  return {
    viewport,
    shown,
    draft,
    setDraft,
    annotating,
    snapshotFailed,
    frameKey,
    error,
    native,
    history,
    frameTarget,
    localFrame,
    text,
    canBack: canGoBack(history),
    canForward: canGoForward(history),
    showAnnotate: Boolean(frameTarget && currentEntry(history)?.loaded),
    submit,
    go,
    reload,
    toggleAnnotate,
    onFrameLoad,
  };
}

async function preparedFile(projectId: string, path: string): Promise<{ address: string; target: string }> {
  const address = displayFileAddress(path);
  try {
    const file = await backend.prepareBrowserFile(projectId, path);
    return { address: file.display || address, target: file.url };
  } catch (err) {
    // 子 webview 挂上后，主窗口不再是 webview window，这条命令会报「没有主窗口」。
    // 命令在报错前已经校验路径并放行目录，这里只补上同等的 asset 地址。
    if (message(err, "") !== "没有主窗口") throw err;
    return { address, target: convertFileSrc(path) };
  }
}

function replaceCurrent(history: BrowserHistory, entry: { address: string; target: string }): BrowserHistory {
  if (history.index < 0) return visit(history, entry);
  const entries = history.entries.slice();
  entries[history.index] = entry;
  return { ...history, entries };
}

function message(error: unknown, fallback: string): string {
  if (typeof error === "string" && error.trim()) return error;
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}
