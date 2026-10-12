import { useCallback, useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, RotateCw } from "lucide-react";

import { convertFileSrc } from "@tauri-apps/api/core";

import { backend, isTauri } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useWorkbench } from "@/store";
import type { PageAnnotation } from "@/types";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { tabTitleFromDocument } from "./annotate";
import { NewTabPage } from "./NewTabPage";
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

export function BrowserView({
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
        mode === "visit"
          ? visit(historyRef.current, entry)
          : replaceCurrent(historyRef.current, entry);
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
        const on = notice.value === "1";
        setAnnotating(on);
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
  const localFrame = frameTarget.startsWith("http://asset.localhost/") || frameTarget.startsWith("https://asset.localhost/");
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

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col" data-browser>
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-zinc-800 bg-zinc-900 px-1.5">
        <ChromeButton
          label={DESKTOP_ZH.browserBack}
          disabled={!canGoBack(history)}
          onClick={() => go("back")}
          data-browser-back
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </ChromeButton>
        <ChromeButton
          label={DESKTOP_ZH.browserForward}
          disabled={!canGoForward(history)}
          onClick={() => go("forward")}
          data-browser-forward
        >
          <ArrowRight className="h-3.5 w-3.5" />
        </ChromeButton>
        <ChromeButton
          label={DESKTOP_ZH.browserReload}
          disabled={!frameTarget}
          onClick={() => {
            if (isTauri && native) void backend.browserReload();
            else setFrameKey((key) => key + 1);
          }}
          data-browser-reload
        >
          <RotateCw className="h-3.5 w-3.5" />
        </ChromeButton>
        {frameTarget && currentEntry(history)?.loaded ? (
          <div className="group relative shrink-0">
            <button
              type="button"
              data-browser-annotate
              aria-pressed={annotating}
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs",
                annotating ? "bg-[#d7e8ff] text-[#2457d6]" : "text-zinc-300 hover:bg-zinc-800",
              )}
              onClick={toggleAnnotate}
            >
              <AnnotatePin />
              {DESKTOP_ZH.browserAnnotate}
            </button>
            <div
              role="tooltip"
              className="pointer-events-none absolute left-0 top-full z-30 mt-1 hidden w-max max-w-[260px] items-center gap-1.5 rounded-lg bg-zinc-950 px-2 py-1.5 text-[11px] leading-4 text-white shadow-lg group-hover:flex"
            >
              <span>{DESKTOP_ZH.browserAnnotateTooltip}</span>
              <kbd className="shrink-0 rounded bg-zinc-700 px-1 py-0.5 text-[10px] text-zinc-100">
                {DESKTOP_ZH.browserAnnotateShortcut}
              </kbd>
            </div>
          </div>
        ) : null}
        <div className="relative min-w-0 flex-1">
          <input
            data-browser-address
            aria-label={DESKTOP_ZH.browserAddressPlaceholder}
            placeholder={DESKTOP_ZH.browserAddressPlaceholder}
            className="h-7 w-full rounded-full border border-zinc-700 bg-zinc-950 px-3 text-xs text-zinc-100 outline-none focus:border-zinc-500"
            value={shown}
            spellCheck={false}
            onFocus={() => setDraft(currentEntry(history)?.address ?? shown)}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => setDraft(null)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submit(draft ?? shown);
              }
            }}
          />
        </div>
      </div>
      {error ? <p className="shrink-0 px-3 py-1 text-xs text-red-300">{error}</p> : null}
      {snapshotFailed ? (
        <p className="shrink-0 px-3 py-1 text-[11px] text-amber-200/90">{DESKTOP_ZH.browserSnapshotFailed}</p>
      ) : null}
      <div ref={viewport} className="relative min-h-0 min-w-0 flex-1 bg-zinc-950" data-browser-viewport>
        {!frameTarget ? <NewTabPage /> : null}
        {!native && frameTarget ? (
          <iframe
            title={shown || DESKTOP_ZH.browserNewTab}
            sandbox="allow-scripts allow-forms allow-popups allow-modals"
            src={localFrame ? undefined : frameTarget}
            srcDoc={localFrame ? text || undefined : undefined}
            key={frameKey}
            className="h-full w-full border-0 bg-zinc-950"
            data-browser-frame="iframe"
            onLoad={() => {
              const current = currentEntry(historyRef.current);
              if (!current || current.loaded) return;
              const entries = historyRef.current.entries.slice();
              entries[historyRef.current.index] = { ...current, loaded: true };
              commit({ ...historyRef.current, entries });
            }}
          />
        ) : null}
      </div>
    </div>
  );
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

function ChromeButton({
  label,
  disabled,
  onClick,
  children,
  ...rest
}: {
  label: string;
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="shrink-0 rounded-md p-1.5 text-zinc-300 hover:bg-zinc-800 disabled:text-zinc-600 disabled:hover:bg-transparent"
      {...rest}
    >
      {children}
    </button>
  );
}

function AnnotatePin() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true">
      <path
        d="M8 1.6a3.6 3.6 0 0 0-3.6 3.6c0 2.7 3.6 7.6 3.6 7.6s3.6-4.9 3.6-7.6A3.6 3.6 0 0 0 8 1.6Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <circle cx="8" cy="5.2" r="1.15" fill="currentColor" />
    </svg>
  );
}

function message(error: unknown, fallback: string): string {
  if (typeof error === "string" && error.trim()) return error;
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}
