import { useCallback, useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, ExternalLink, RotateCw } from "lucide-react";

import { backend, isTauri } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useWorkbench } from "@/store";
import type { PageAnnotation } from "@/types";
import { CODEX_DESKTOP } from "../codex-desktop";
import { tabTitleFromDocument } from "./annotate";
import {
  canGoBack,
  canGoForward,
  currentEntry,
  displayFileAddress,
  goBack,
  goForward,
  noteLoaded,
  pageTitleFromHtml,
  parseAddressInput,
  recallHistory,
  rememberHistory,
  visit,
  type BrowserHistory,
} from "./browser";
import { usePreview } from "./preview-context";

export function BrowserView({
  tabId,
  projectId,
  path,
  text,
  onTitle,
}: {
  tabId: string;
  projectId: string;
  path: string;
  text: string;
  onTitle: (title: string) => void;
}) {
  const { sessionId } = usePreview();
  const viewport = useRef<HTMLDivElement>(null);
  const [history, setHistory] = useState<BrowserHistory>(() => recallHistory(tabId));
  const [draft, setDraft] = useState<string | null>(null);
  const [annotating, setAnnotating] = useState(false);
  const [suspended, setSuspended] = useState(false);
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

  const commit = useCallback(
    (next: BrowserHistory) => {
      historyRef.current = next;
      rememberHistory(tabId, next);
      setHistory(next);
    },
    [tabId],
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
        setError(message(err, CODEX_DESKTOP.browserOpenFailed));
      }
    },
    [commit, native, placeNative],
  );

  useEffect(() => {
    const title = tabTitleFromDocument(pageTitleFromHtml(text));
    if (title) onTitle(title);
  }, [onTitle, text]);

  const openedFile = useRef("");
  useEffect(() => {
    if (!path) return;
    const address = displayFileAddress(path);
    const key = `${projectId}\n${address}`;
    if (openedFile.current === key) return;
    let cancel = false;
    void backend
      .prepareBrowserFile(projectId, path)
      .then((file) => {
        if (cancel) return;
        openedFile.current = key;
        return openTarget({ address: file.display || address, target: file.url }, "visit");
      })
      .catch((err: unknown) => {
        if (cancel) return;
        openedFile.current = "";
        setError(message(err, CODEX_DESKTOP.browserOpenFailed));
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
        if (title) onTitle(title);
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
        if (!on) setSuspended(false);
      }
      if (notice.kind === "suspended") setSuspended(notice.value === "1");
      if (notice.kind === "annotation") {
        try {
          const note = JSON.parse(notice.value) as PageAnnotation;
          if (!note.id) return;
          useWorkbench.getState().addPageAnnotation(sessionRef.current, note);
          setSnapshotFailed(Boolean(note.snapshotFailed));
        } catch {
          setError(CODEX_DESKTOP.browserAnnotateFailed);
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

  const submit = (value: string) => {
    const plan = parseAddressInput(value);
    setDraft(null);
    if (plan.kind === "invalid") {
      setError(CODEX_DESKTOP.browserOpenFailed);
      return;
    }
    if (plan.kind === "navigate") {
      void openTarget({ address: plan.address, target: plan.target }, "visit");
      return;
    }
    void backend
      .prepareBrowserFile(projectId, plan.path)
      .then((file) => openTarget({ address: file.display, target: file.url }, "visit"))
      .catch((err: unknown) => setError(message(err, CODEX_DESKTOP.browserOpenFailed)));
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
          label={CODEX_DESKTOP.browserBack}
          disabled={!canGoBack(history)}
          onClick={() => go("back")}
          data-browser-back
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </ChromeButton>
        <ChromeButton
          label={CODEX_DESKTOP.browserForward}
          disabled={!canGoForward(history)}
          onClick={() => go("forward")}
          data-browser-forward
        >
          <ArrowRight className="h-3.5 w-3.5" />
        </ChromeButton>
        <ChromeButton
          label={CODEX_DESKTOP.browserReload}
          disabled={!frameTarget}
          onClick={() => {
            if (isTauri && native) void backend.browserReload();
            else setFrameKey((key) => key + 1);
          }}
          data-browser-reload
        >
          <RotateCw className="h-3.5 w-3.5" />
        </ChromeButton>
        <input
          data-browser-address
          aria-label={CODEX_DESKTOP.browserAddressPlaceholder}
          placeholder={CODEX_DESKTOP.browserAddressPlaceholder}
          className="h-7 min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 text-xs text-zinc-100 outline-none focus:border-zinc-500"
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
        <button
          type="button"
          data-browser-annotate
          aria-pressed={annotating}
          title={CODEX_DESKTOP.browserAnnotateTooltip}
          className={cn(
            "shrink-0 rounded-md px-2 py-1 text-xs",
            annotating ? "bg-sky-500/20 text-sky-200" : "text-zinc-300 hover:bg-zinc-800",
          )}
          onClick={() => {
            const next = !annotating;
            setAnnotating(next);
            if (!next) setSuspended(false);
            if (isTauri && native) {
              void backend.browserAnnotate(next).catch(() => {
                setError(CODEX_DESKTOP.browserAnnotateFailed);
              });
            }
          }}
        >
          {annotating ? CODEX_DESKTOP.browserAnnotating : CODEX_DESKTOP.browserAnnotate}
        </button>
        <ChromeButton
          label={CODEX_DESKTOP.browserOpenExternal}
          disabled={!shown}
          data-browser-external
          onClick={() => {
            const target = currentEntry(history)?.address || shown;
            void backend.browserOpenExternal(target).catch((err: unknown) => {
              setError(message(err, CODEX_DESKTOP.browserExternalFailed));
            });
          }}
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </ChromeButton>
      </div>
      {error ? <p className="shrink-0 px-3 py-1 text-xs text-red-300">{error}</p> : null}
      {annotating ? (
        <p className="shrink-0 truncate px-3 py-1 text-[11px] text-zinc-400" data-browser-annotate-hint>
          {suspended ? CODEX_DESKTOP.browserAnnotateSuspended : CODEX_DESKTOP.browserAnnotateHint}
        </p>
      ) : null}
      {snapshotFailed ? (
        <p className="shrink-0 px-3 py-1 text-[11px] text-amber-200/90">{CODEX_DESKTOP.browserSnapshotFailed}</p>
      ) : null}
      <div ref={viewport} className="relative min-h-0 min-w-0 flex-1 bg-zinc-950" data-browser-viewport>
        {!frameTarget ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 bg-zinc-950 px-6 text-center">
            <p className="text-sm text-zinc-200">{CODEX_DESKTOP.browserEmptyTitle}</p>
            <p className="text-xs text-zinc-500">{CODEX_DESKTOP.browserEmptyDescription}</p>
          </div>
        ) : null}
        {!native && frameTarget ? (
          <iframe
            title={shown || CODEX_DESKTOP.browserEmptyTitle}
            sandbox="allow-scripts allow-forms allow-popups allow-modals"
            src={localFrame ? undefined : frameTarget}
            srcDoc={localFrame ? text || undefined : undefined}
            key={frameKey}
            className="h-full w-full border-0 bg-zinc-950"
            data-browser-frame="iframe"
          />
        ) : null}
      </div>
    </div>
  );
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
  onClick: () => void;
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

function message(error: unknown, fallback: string): string {
  if (typeof error === "string" && error.trim()) return error;
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}
