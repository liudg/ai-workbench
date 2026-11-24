import {
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  Archive,
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  FileCode2,
  FileSearch,
  FolderOpen,
  FolderTree,
  GitCompareArrows,
  GitFork,
  MessageSquare,
  MessageSquarePlus,
  MessagesSquare,
  PanelLeft,
  Pencil,
  Pin,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Sparkles,
  SquareKanban,
  SquarePen,
  SquareTerminal,
  SunMoon,
  TextSearch,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { HighlightedSnippet } from "@/shared/search";

import { COMMAND_MENU_COPY as COPY } from "./copy";
import type { PaletteCommandId, PaletteRow } from "./commands";
import { jumpSection, moveCursor, sectionStarts } from "./keyboard";

export type PaletteDrill = "commands" | "chats" | "files" | "rename" | "delete";

export function CommandMenu({
  query,
  rows,
  active,
  drill,
  renameTitle,
  renameError,
  deleteError,
  notice,
  emptyText,
  dirtyWorktree = false,
  deleteReady = true,
  onQuery,
  onActive,
  onRun,
  onClose,
  onBack,
  onRenameTitle,
  onRenameSubmit,
  onDeleteConfirm,
  onKeepWorktree,
  onDiscardWorktree,
}: {
  query: string;
  rows: readonly PaletteRow[];
  active: number;
  drill: PaletteDrill;
  renameTitle: string;
  renameError: string | null;
  deleteError: string | null;
  notice?: string | null;
  emptyText?: string;
  dirtyWorktree?: boolean;
  deleteReady?: boolean;
  onQuery: (value: string) => void;
  onActive: (index: number) => void;
  onRun: (index: number) => void;
  onClose: () => void;
  onBack: () => void;
  onRenameTitle: (value: string) => void;
  onRenameSubmit: () => void;
  onDeleteConfirm: () => void;
  onKeepWorktree?: () => void;
  onDiscardWorktree?: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelDeleteRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchingChats = drill === "chats";
  const placeholder =
    drill === "files" ? COPY.filePlaceholder : searchingChats ? COPY.chatPlaceholder : COPY.placeholder;

  useEffect(() => {
    if (drill === "delete") {
      (cancelDeleteRef.current ?? dialogRef.current)?.focus();
      return;
    }
    inputRef.current?.focus();
  }, [drill]);

  useEffect(() => {
    listRef.current
      ?.querySelector("[data-command-active='true']")
      ?.scrollIntoView?.({ block: "nearest" });
  }, [active, rows]);

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (drill === "commands" || drill === "files") onClose();
      else onBack();
      return;
    }
    if (drill === "rename") {
      if (event.key === "Enter") {
        event.preventDefault();
        onRenameSubmit();
      }
      return;
    }
    if (drill === "delete") {
      const onButton = event.target instanceof HTMLElement && event.target.closest("button") !== null;
      if (event.key === "Enter" && deleteReady && !dirtyWorktree && !onButton) {
        event.preventDefault();
        onDeleteConfirm();
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      onActive(moveCursor(active, rows.length, event.key));
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      const starts = sectionStarts(rows.map((row) => row.group));
      onActive(jumpSection(starts, active, event.shiftKey ? -1 : 1));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      onRun(active);
    }
  };

  if (typeof document === "undefined") return null;

  const emptyLabel =
    emptyText ?? (searchingChats && query.trim().length === 0 ? COPY.noChats : COPY.empty);

  const hideGroupHeader =
    drill === "files" ||
    (searchingChats && query.trim().length > 0 && !rows.some((row) => row.group === "messages"));
  const showList = drill === "commands" || drill === "chats" || drill === "files";

  return createPortal(
    <div
      className="wb-backdrop-in fixed inset-x-0 bottom-0 top-[var(--wb-shell-top,0px)] z-[60] flex items-start justify-center bg-wb-backdrop pt-16 backdrop-blur-[2px]"
      data-command-menu
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label={drill === "files" ? COPY.quickOpen : COPY.title}
        data-command-drill={drill}
        aria-describedby="command-menu-description"
        onKeyDown={onKeyDown}
        className="wb-modal flex max-h-[min(540px,72vh)] w-[min(480px,92vw)] flex-col overflow-hidden text-xs outline-none"
      >
        <p id="command-menu-description" className="sr-only">
          {COPY.description}
        </p>
        <div className="flex items-center gap-2.5 border-b border-wb-border bg-wb-surface px-3.5">
          {drill !== "commands" ? (
            <button
              type="button"
              className="inline-flex shrink-0 items-center gap-1 rounded-md border border-wb-border bg-wb-elev/70 px-2 py-1 text-xs font-medium text-wb-fg-2 transition-colors hover:bg-wb-hover hover:text-wb-fg"
              onClick={onBack}
            >
              <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{COPY.back}</span>
            </button>
          ) : (
            <Search className="h-4 w-4 shrink-0 text-wb-fg-3" strokeWidth={1.8} aria-hidden="true" />
          )}
          {drill === "rename" || drill === "delete" ? (
            <span className="py-3 text-sm font-semibold text-wb-fg">
              {drill === "rename" ? COPY.renameTitle : COPY.deleteTitle}
            </span>
          ) : (
            <>
              <input
                ref={inputRef}
                value={query}
                placeholder={placeholder}
                aria-label={placeholder}
                data-command-query
                onChange={(event) => onQuery(event.target.value)}
                className="h-11 min-w-0 flex-1 bg-transparent text-[13.5px] text-wb-fg outline-none placeholder:text-wb-dim"
              />
              <button
                type="button"
                onClick={onClose}
                className="shrink-0 rounded border border-wb-border bg-wb-elev/80 px-1.5 py-0.5 font-mono text-[11px] leading-4 text-wb-fg-3 transition-colors hover:bg-wb-hover hover:text-wb-fg"
              >
                Esc
              </button>
            </>
          )}
        </div>
        {drill === "rename" ? (
          <RenameDrill
            title={renameTitle}
            error={renameError}
            inputRef={inputRef}
            onTitle={onRenameTitle}
            onSubmit={onRenameSubmit}
            onCancel={onBack}
          />
        ) : null}
        {drill === "delete" ? (
          <DeleteDrill
            error={deleteError}
            dirtyWorktree={dirtyWorktree}
            ready={deleteReady}
            cancelRef={cancelDeleteRef}
            onConfirm={onDeleteConfirm}
            onKeep={onKeepWorktree}
            onDiscard={onDiscardWorktree}
            onCancel={onBack}
          />
        ) : null}
        {notice ? (
          <p className="px-3.5 pt-2.5 text-xs text-wb-fg-2" data-command-notice>
            {notice}
          </p>
        ) : null}
        {showList ? (
          <div
            ref={listRef}
            role="listbox"
            aria-label={drill === "files" ? COPY.quickOpen : COPY.title}
            className="min-h-0 flex-1 overflow-y-auto p-1.5"
            data-command-list
          >
            {rows.length === 0 ? (
              <p className="px-4 py-8 text-center text-xs text-wb-fg-3" data-command-empty>
                {emptyLabel}
              </p>
            ) : (
              <RowList
                rows={rows}
                active={active}
                query={query}
                hideGroupHeader={hideGroupHeader}
                onActive={onActive}
                onRun={onRun}
              />
            )}
          </div>
        ) : null}
        {showList && rows.length > 0 ? (
          <div className="flex items-center justify-between border-t border-wb-border bg-wb-surface px-3.5 py-1.5 text-xs text-wb-group-fg">
            <span>↑↓ 选择 · ↵ 执行</span>
            {!hideGroupHeader ? <span>Tab 切换分组</span> : null}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

function RowList({
  rows,
  active,
  query,
  hideGroupHeader,
  onActive,
  onRun,
}: {
  rows: readonly PaletteRow[];
  active: number;
  query: string;
  hideGroupHeader: boolean;
  onActive: (index: number) => void;
  onRun: (index: number) => void;
}) {
  const sections: { group: string; label: string; rows: { row: PaletteRow; index: number }[] }[] = [];
  rows.forEach((row, index) => {
    const last = sections[sections.length - 1];
    if (!last || last.group !== row.group) {
      sections.push({ group: row.group, label: row.groupLabel, rows: [{ row, index }] });
    } else {
      last.rows.push({ row, index });
    }
  });
  return (
    <>
      {sections.map((section) => (
        <section key={section.group} data-command-menu-search-section={section.group} className="pb-1.5 last:pb-0">
          {!hideGroupHeader ? (
            <h2 className="wb-group-header px-2.5 pb-1 pt-2 first:pt-1">{section.label}</h2>
          ) : null}
          <div className="space-y-0.5">
            {section.rows.map(({ row, index }) => {
              const selected = index === active;
              const danger = row.commandId === "delete";
              if (row.kind === "message") {
                return (
                  <button
                    key={row.key}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    data-command-row={row.sessionId}
                    data-command-row-kind="message"
                    data-command-event-id={row.eventId ?? ""}
                    data-command-active={selected ? "true" : "false"}
                    className={cn(
                      "flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] leading-5 transition-colors",
                      selected
                        ? "wb-menu-active font-medium"
                        : "text-wb-fg hover:bg-wb-hover",
                    )}
                    onMouseEnter={() => onActive(index)}
                    onClick={() => onRun(index)}
                  >
                    <RowIcon row={row} selected={selected} />
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <HighlightedSnippet
                          snippet={row.label}
                          query={query}
                          className="min-w-0 flex-1 truncate font-medium text-wb-fg"
                        />
                        {row.projectName ? (
                          <span
                            data-command-hit-project=""
                            className="max-w-[32%] shrink truncate rounded bg-wb-elev/70 px-1.5 py-0.5 text-[11px] leading-3.5 text-wb-fg-3"
                          >
                            {row.projectName}
                          </span>
                        ) : null}
                        {row.archived ? (
                          <span
                            data-command-hit-archived=""
                            className="shrink-0 rounded border border-wb-border bg-wb-elev/70 px-1 py-0.5 text-[10px] leading-3.5 text-wb-fg-3"
                          >
                            {COPY.archivedBadge}
                          </span>
                        ) : null}
                        {row.roleLabel ? (
                          <span
                            data-command-hit-role=""
                            className="shrink-0 rounded border border-wb-border bg-wb-elev/80 px-1.5 py-0.5 text-[10px] leading-3.5 text-wb-fg-2"
                          >
                            {row.roleLabel}
                          </span>
                        ) : null}
                      </div>
                      {row.snippet && row.snippet.trim() !== row.label.trim() ? (
                        <HighlightedSnippet
                          snippet={row.snippet}
                          query={query}
                          className="mt-0.5 block truncate text-xs font-normal leading-4 text-wb-fg-2"
                        />
                      ) : null}
                    </div>
                  </button>
                );
              }
              return (
                <button
                  key={row.key}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  data-command-row={row.commandId ?? row.sessionId ?? row.filePath}
                  data-command-row-kind={row.kind}
                  data-command-active={selected ? "true" : "false"}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] leading-5 transition-colors",
                    selected
                      ? "wb-menu-active font-medium"
                      : "text-wb-fg hover:bg-wb-hover",
                    danger && "text-wb-danger",
                  )}
                  onMouseEnter={() => onActive(index)}
                  onClick={() => onRun(index)}
                >
                  <RowIcon row={row} selected={selected} />
                  <span className="min-w-0 flex-1 truncate">
                    {row.kind === "command" ? row.label : highlight(row.label, query)}
                  </span>
                  {row.detail ? (
                    <span className="max-w-[42%] shrink truncate text-right text-xs text-wb-fg-3" data-command-detail>
                      {row.detail}
                    </span>
                  ) : null}
                  {row.shortcut ? (
                    <kbd
                      className={cn(
                        "shrink-0 rounded border px-1.5 py-0.5 font-mono text-[11px] leading-4",
                        selected && !danger
                          ? "border-wb-accent/20 bg-wb-surface text-wb-accent-ink"
                          : "border-wb-border bg-wb-elev/80 text-wb-fg-3",
                      )}
                      data-command-shortcut
                    >
                      {row.shortcut}
                    </kbd>
                  ) : null}
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </>
  );
}

function RowIcon({ row, selected }: { row: PaletteRow; selected: boolean }) {
  const danger = row.commandId === "delete";
  const className = cn(
    "h-[15px] w-[15px] shrink-0",
    danger ? "text-wb-danger" : selected ? "text-wb-accent-ink" : "text-wb-fg-3",
  );
  if (row.kind === "message") {
    return <TextSearch className={cn(className, "mt-0.5 self-start")} strokeWidth={1.8} aria-hidden="true" />;
  }
  if (row.kind === "chat") return <MessageSquare className={className} strokeWidth={1.8} aria-hidden="true" />;
  if (row.kind === "file") return <FileCode2 className={className} strokeWidth={1.8} aria-hidden="true" />;
  const Icon = commandIcon(row.commandId);
  return <Icon className={className} strokeWidth={1.8} aria-hidden="true" />;
}

function commandIcon(id: PaletteCommandId | undefined) {
  switch (id) {
    case "new-thread":
      return SquarePen;
    case "new-standalone":
      return MessageSquarePlus;
    case "open-folder":
      return FolderOpen;
    case "toggle-theme":
      return SunMoon;
    case "settings":
      return SlidersHorizontal;
    case "check-updates":
      return RefreshCw;
    case "search-chats":
      return Search;
    case "find-in-thread":
      return TextSearch;
    case "rename":
      return Pencil;
    case "pin":
      return Pin;
    case "fork":
      return GitFork;
    case "archive":
      return Archive;
    case "delete":
      return Trash2;
    case "next-attention":
      return Sparkles;
    case "prev-session":
      return ArrowUp;
    case "next-session":
      return ArrowDown;
    case "board":
      return SquareKanban;
    case "quick-open":
    case "search-files":
      return FileSearch;
    case "toggle-sidebar":
      return PanelLeft;
    case "toggle-files":
      return FolderTree;
    case "toggle-changes":
      return GitCompareArrows;
    case "toggle-terminal":
      return SquareTerminal;
    case "toggle-side-chat":
      return MessagesSquare;
    default:
      return Sparkles;
  }
}

function highlight(label: string, query: string): ReactNode {
  const needle = query.trim();
  if (!needle) return label;
  const at = label.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0) return label;
  return (
    <>
      {label.slice(0, at)}
      <mark className="bg-transparent font-medium text-wb-fg underline decoration-wb-accent/80 underline-offset-2">
        {label.slice(at, at + needle.length)}
      </mark>
      {label.slice(at + needle.length)}
    </>
  );
}

function RenameDrill({
  title,
  error,
  inputRef,
  onTitle,
  onSubmit,
  onCancel,
}: {
  title: string;
  error: string | null;
  inputRef: RefObject<HTMLInputElement>;
  onTitle: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="space-y-3 px-4 py-4" data-command-drill="rename">
      <p className="text-sm text-wb-fg-2">{COPY.renameDescription}</p>
      <Input
        ref={inputRef}
        aria-label={COPY.renameAria}
        placeholder={COPY.renamePlaceholder}
        value={title}
        onChange={(event) => onTitle(event.target.value)}
      />
      {error ? <p className="text-sm text-wb-danger">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {COPY.cancel}
        </Button>
        <Button type="button" size="sm" disabled={!title.trim()} onClick={onSubmit}>
          {COPY.save}
        </Button>
      </div>
    </div>
  );
}

function DeleteDrill({
  error,
  dirtyWorktree,
  ready,
  cancelRef,
  onConfirm,
  onKeep,
  onDiscard,
  onCancel,
}: {
  error: string | null;
  dirtyWorktree: boolean;
  ready: boolean;
  cancelRef: RefObject<HTMLButtonElement>;
  onConfirm: () => void;
  onKeep?: () => void;
  onDiscard?: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="space-y-3 px-4 py-4" data-command-drill="delete" data-dirty-worktree={dirtyWorktree ? "true" : "false"}>
      <p className="text-sm text-wb-fg-2">
        {dirtyWorktree ? COPY.deleteDirtyWorktree : COPY.deleteDescription}
      </p>
      {error ? <p className="text-sm text-wb-danger">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <Button ref={cancelRef} type="button" variant="ghost" size="sm" onClick={onCancel}>
          {COPY.cancel}
        </Button>
        {dirtyWorktree ? (
          <Button type="button" variant="outline" size="sm" disabled={!ready} onClick={onKeep}>
            {COPY.keepWorktree}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="destructive"
          size="sm"
          disabled={!ready}
          onClick={dirtyWorktree ? onDiscard : onConfirm}
        >
          {dirtyWorktree ? COPY.discardWorktree : COPY.deleteAction}
        </Button>
      </div>
    </div>
  );
}
