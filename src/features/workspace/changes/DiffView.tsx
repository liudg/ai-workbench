import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight } from "lucide-react";

import { backend } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { AssistantAnswer } from "../timeline/AssistantAnswer";
import { CODEX_DESKTOP } from "../codex-desktop";
import { FileDirectoryGroups } from "./FileDirectoryGroups";
import {
  applyWordDiff,
  baseName,
  diffScopeMenu,
  expandDiffLines,
  fileStatusTone,
  foldDiffLines,
  parseUnifiedDiff,
  previewKindForPath,
  previewTextFromDiff,
  unmodifiedLinesLabel,
  withoutWhitespaceChanges,
  type DiffDisplayRow,
  type FileChange,
  type FileStatus,
} from "./model";
import { usePreview } from "./preview-context";

const SCOPES = diffScopeMenu();

export function DiffView({ files: turnFiles }: { files: FileChange[] }) {
  const preview = usePreview();
  const [scope, setScope] = useState("turn");
  const [open, setOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [filter, setFilter] = useState("");
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
  const menuRef = useRef<HTMLDivElement>(null);
  const optionsRef = useRef<HTMLDivElement>(null);
  const current = SCOPES.find((item) => item.id === scope) ?? SCOPES[0];

  useEffect(() => {
    if (!open && !optionsOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      setOptionsOpen(false);
    };
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (open && !menuRef.current?.contains(target)) setOpen(false);
      if (optionsOpen && !optionsRef.current?.contains(target)) setOptionsOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onPointer);
    };
  }, [open, optionsOpen]);

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
    void backend
      .projectGitDiff(preview.projectId, scope, hideWs)
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
  }, [hideWs, preview.projectId, scope]);

  const listed = useMemo(() => {
    const source = scope === "turn" ? turnFiles : (gitFiles ?? []);
    if (scope !== "turn" || !hideWs) return source;
    return source.flatMap((file) => {
      const parsed = parseUnifiedDiff(withoutWhitespaceChanges(file.diff)).filter(
        (item) => item.added + item.removed > 0,
      );
      return parsed.map((item) => ({ ...item, status: file.status }));
    });
  }, [gitFiles, hideWs, scope, turnFiles]);

  const query = filter.trim().toLowerCase();
  const shown = listed.filter((file) => {
    if (hidden.includes(file.path)) return false;
    if (!query) return true;
    return file.path.toLowerCase().includes(query);
  });
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
        .readPreviewFile(preview.projectId, path)
        .then((doc) => {
          if (doc.kind === "binary") return;
          setSources((current) =>
            Object.prototype.hasOwnProperty.call(current, path) ? current : { ...current, [path]: doc.text },
          );
        })
        .catch(() => {});
    }
  }, [expanded, loadFull, preview.projectId, renderPreview, sourceKey]);

  const jump = () => {
    if (!active) return;
    preview.openHref(active.path);
  };
  const hideActive = () => {
    if (!active) return;
    setHidden((current) => (current.includes(active.path) ? current : [...current, active.path]));
  };

  return (
    <div className="flex h-full min-h-0 min-w-0" data-diff-view>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-zinc-800 px-3 py-2">
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              data-diff-scope
              aria-expanded={open}
              aria-haspopup="menu"
              className="inline-flex items-center gap-1 rounded-full bg-zinc-800 px-2.5 py-1 text-xs text-zinc-100"
              onClick={() => {
                setOptionsOpen(false);
                setOpen((value) => !value);
              }}
            >
              {current.label}
              <ChevronDown className="h-3 w-3 text-zinc-400" />
            </button>
            {open ? (
              <div
                role="menu"
                data-diff-scope-menu
                className="absolute left-0 top-full z-20 mt-1 w-40 rounded-xl border border-zinc-700 bg-zinc-900 py-1 shadow-lg"
              >
                {SCOPES.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="menuitem"
                    disabled={item.submenu}
                    aria-disabled={item.submenu || undefined}
                    data-diff-scope-item={item.id}
                    data-submenu={item.submenu ? "true" : "false"}
                    className={cn(
                      "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs",
                      item.submenu ? "cursor-default text-zinc-500" : "text-zinc-100 hover:bg-zinc-800",
                    )}
                    onClick={() => {
                      if (item.submenu) return;
                      setScope(item.id);
                      setOpen(false);
                    }}
                  >
                    <span className="min-w-0 flex-1">{item.label}</span>
                    {scope === item.id ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
                    {item.submenu ? <ChevronRight className="h-3.5 w-3.5 shrink-0 text-zinc-500" /> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <span className="font-mono text-xs text-emerald-400">+{added}</span>
          <span className="font-mono text-xs text-red-400">-{removed}</span>
          <button type="button" data-diff-jump className="text-xs text-zinc-200 hover:text-white" onClick={jump}>
            {CODEX_DESKTOP.diffJump}
          </button>
          <button
            type="button"
            data-diff-expand
            aria-pressed={expanded}
            className="text-xs text-zinc-200 hover:text-white"
            onClick={() => setExpanded((value) => !value)}
          >
            {CODEX_DESKTOP.diffExpand}
          </button>
          <button
            type="button"
            data-diff-unified
            aria-pressed={unified}
            className="text-xs text-zinc-200 hover:text-white"
            onClick={() => setUnified((value) => !value)}
          >
            {CODEX_DESKTOP.diffUnified}
          </button>
          <button type="button" data-diff-hide className="text-xs text-zinc-200 hover:text-white" onClick={hideActive}>
            {CODEX_DESKTOP.diffHideFile}
          </button>
          <div className="relative" ref={optionsRef}>
            <button
              type="button"
              data-diff-options
              aria-expanded={optionsOpen}
              aria-haspopup="menu"
              className="inline-flex items-center gap-1 text-xs text-zinc-200 hover:text-white"
              onClick={() => {
                setOpen(false);
                setOptionsOpen((value) => !value);
              }}
            >
              {CODEX_DESKTOP.changesTab}
              <ChevronDown className="h-3 w-3 text-zinc-400" />
            </button>
            {optionsOpen ? (
              <div
                role="menu"
                data-diff-options-menu
                className="absolute left-0 top-full z-20 mt-1 w-52 rounded-xl border border-zinc-700 bg-zinc-900 py-1 shadow-lg"
              >
                <OptionRow
                  label={CODEX_DESKTOP.diffLoadFull}
                  checked={loadFull}
                  onClick={() => setLoadFull((value) => !value)}
                />
                <OptionRow
                  label={CODEX_DESKTOP.diffRender}
                  checked={renderPreview}
                  onClick={() => setRenderPreview((value) => !value)}
                />
                <OptionRow
                  label={CODEX_DESKTOP.diffWord}
                  checked={wordDiff}
                  onClick={() => setWordDiff((value) => !value)}
                />
                <OptionRow
                  label={CODEX_DESKTOP.diffHideSpace}
                  checked={hideWs}
                  onClick={() => setHideWs((value) => !value)}
                />
                <button
                  type="button"
                  role="menuitem"
                  disabled
                  aria-disabled="true"
                  data-diff-copy-apply
                  className="flex w-full cursor-default px-3 py-1.5 text-left text-xs text-zinc-500"
                >
                  {CODEX_DESKTOP.diffCopyApply}
                </button>
              </div>
            ) : null}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {loading ? <p className="px-4 py-6 text-sm text-zinc-500">正在读取…</p> : null}
          {gitError ? <p className="px-4 py-6 text-sm text-red-300">{gitError}</p> : null}
          {!loading && !gitError && shown.length === 0 ? (
            <p className="px-4 py-6 text-sm text-zinc-500">{CODEX_DESKTOP.noFileChanges}</p>
          ) : null}
          {shown.map((file) => (
            <FileSection
              key={file.path}
              file={file}
              expanded={expanded}
              unified={unified}
              wordDiff={wordDiff}
              renderPreview={renderPreview}
              source={loadFull ? (sources[file.path] ?? null) : null}
              active={file.path === active?.path}
              onSelect={() => setActivePath(file.path)}
            />
          ))}
        </div>
      </div>
      <aside className="flex w-52 shrink-0 flex-col border-l border-zinc-800">
        <div className="p-2">
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={CODEX_DESKTOP.filterFiles}
            aria-label={CODEX_DESKTOP.filterFiles}
            data-diff-filter
            className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-zinc-600"
          />
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
          <FileDirectoryGroups
            files={shown}
            render={(file) => (
              <li key={file.path}>
                <button
                  type="button"
                  data-diff-file={file.path}
                  className={cn(
                    "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left",
                    file.path === active?.path ? "bg-zinc-800" : "hover:bg-zinc-900",
                  )}
                  onClick={() => {
                    setActivePath(file.path);
                    document
                      .querySelector(`[data-diff-file-body="${cssEscape(file.path)}"]`)
                      ?.scrollIntoView({ block: "nearest" });
                  }}
                >
                  <StatusMark status={file.status} />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-200">
                    {baseName(file.path)}
                  </span>
                  <span className="shrink-0 font-mono text-[11px] text-emerald-400">+{file.added}</span>
                  <span className="shrink-0 font-mono text-[11px] text-red-400">-{file.removed}</span>
                </button>
              </li>
            )}
          />
        </ul>
      </aside>
    </div>
  );
}

function FileSection({
  file,
  expanded,
  unified,
  wordDiff,
  renderPreview,
  source,
  active,
  onSelect,
}: {
  file: FileChange;
  expanded: boolean;
  unified: boolean;
  wordDiff: boolean;
  renderPreview: boolean;
  source: string | null;
  active: boolean;
  onSelect: () => void;
}) {
  const markdown = previewKindForPath(file.path) === "markdown";
  const folded = foldDiffLines(file.diff);
  const rows = wordDiff ? applyWordDiff(expanded ? expandDiffLines(file.diff, source) : folded) : null;
  const plain = expanded ? expandDiffLines(file.diff, source) : folded;
  return (
    <section
      className={cn("border-b border-zinc-800", active && "bg-zinc-950")}
      data-diff-file-body={file.path}
      onClick={onSelect}
    >
      <header className="flex min-w-0 items-center gap-2 px-3 py-2 text-xs">
        <span className="min-w-0 flex-1 truncate font-mono text-zinc-300"># {baseName(file.path)}</span>
        <span className="font-mono text-emerald-400">+{file.added}</span>
        <span className="font-mono text-red-400">-{file.removed}</span>
      </header>
      {renderPreview && markdown ? (
        <div className="px-4 py-3">
          <AssistantAnswer text={source && source.length > 0 ? source : previewTextFromDiff(file.diff)} />
        </div>
      ) : unified ? (
        <pre className="whitespace-pre-wrap break-words px-3 pb-3 font-mono text-xs leading-5 text-zinc-300">
          {file.diff}
        </pre>
      ) : (wordDiff ? rows : plain)?.length === 0 ? (
        <p className="px-3 py-2 text-xs text-zinc-500">没有可显示的差异文本。</p>
      ) : (
        <div className="pb-2 font-mono text-xs leading-5">
          {(wordDiff ? rows : plain.map((row) => (row.kind === "collapse" ? row : { ...row, parts: null })))?.map(
            (row, index) => (
              <DiffRowView key={index} row={row} />
            ),
          )}
        </div>
      )}
    </section>
  );
}

function DiffRowView({ row }: { row: DiffDisplayRow }) {
  if (row.kind === "collapse") {
    return (
      <div data-unmodified-lines={row.count} className="mx-3 my-1 rounded bg-zinc-800 px-3 py-1 text-zinc-400">
        {unmodifiedLinesLabel(row.count)}
      </div>
    );
  }
  return (
    <div
      className={cn(
        "flex min-w-0",
        row.tone === "add" && "bg-emerald-500/15 text-emerald-200",
        row.tone === "del" && "bg-red-500/15 text-red-200",
        row.tone === "context" && "text-zinc-300",
        row.tone === "meta" && "text-zinc-500",
      )}
    >
      <span className="w-10 shrink-0 select-none px-2 text-right text-zinc-500">{row.lineNo ?? ""}</span>
      <span className="min-w-0 flex-1 whitespace-pre px-2">
        {row.parts && row.parts.length > 0
          ? row.parts.map((part, index) => (
              <span key={index} className={part.changed ? "rounded-sm bg-white/10" : undefined}>
                {part.text.length > 0 ? part.text : " "}
              </span>
            ))
          : row.text.length > 0
            ? row.text
            : " "}
      </span>
    </div>
  );
}

function OptionRow({ label, checked, onClick }: { label: string; checked: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      data-diff-option={label}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-100 hover:bg-zinc-800"
      onClick={onClick}
    >
      <span className="min-w-0 flex-1">{label}</span>
      {checked ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
    </button>
  );
}

function StatusMark({ status }: { status: FileStatus }) {
  const tone = fileStatusTone(status);
  return (
    <span
      data-file-status={status}
      className={cn(
        "w-4 shrink-0 font-mono text-[11px]",
        tone === "add" && "text-emerald-400",
        tone === "del" && "text-red-400",
        tone === "neutral" && "text-zinc-400",
      )}
    >
      {status}
    </span>
  );
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
