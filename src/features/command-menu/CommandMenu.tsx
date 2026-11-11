import {
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import { COMMAND_MENU_COPY as COPY } from "./copy";
import type { PaletteRow } from "./commands";
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
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchingChats = drill === "chats";
  const placeholder =
    drill === "files" ? COPY.filePlaceholder : searchingChats ? COPY.chatPlaceholder : COPY.placeholder;

  useEffect(() => {
    inputRef.current?.focus();
  }, [drill]);

  useEffect(() => {
    listRef.current
      ?.querySelector("[data-command-active='true']")
      ?.scrollIntoView({ block: "nearest" });
  }, [active, rows]);

  const onKeyDown = (event: ReactKeyboardEvent) => {
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
      if (event.key === "Enter" && deleteReady && !dirtyWorktree) {
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

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-[var(--wb-backdrop)] pt-[12vh] backdrop-blur-[2px]"
      data-command-menu
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-label={drill === "files" ? COPY.quickOpen : COPY.title}
        data-command-drill={drill}
        aria-describedby="command-menu-description"
        onKeyDown={onKeyDown}
        className="flex max-h-[min(560px,70vh)] w-[min(640px,94vw)] flex-col overflow-hidden rounded-2xl border border-[var(--wb-border-strong)] bg-[var(--wb-elev)] text-[var(--wb-text)] shadow-[var(--wb-float-shadow)]"
      >
        <p id="command-menu-description" className="sr-only">
          {COPY.description}
        </p>
        <div className="flex items-center gap-2 border-b border-[var(--wb-border)] px-3.5">
          {drill !== "commands" ? (
            <button
              type="button"
              className="shrink-0 text-xs text-[var(--wb-muted)] hover:text-[var(--wb-text-strong)]"
              onClick={onBack}
            >
              {COPY.back}
            </button>
          ) : null}
          {drill === "rename" || drill === "delete" ? (
            <span className="py-3 text-sm font-medium text-[var(--wb-text-strong)]">
              {drill === "rename" ? COPY.renameTitle : COPY.deleteTitle}
            </span>
          ) : (
            <input
              ref={inputRef}
              value={query}
              placeholder={placeholder}
              aria-label={placeholder}
              data-command-query
              onChange={(event) => onQuery(event.target.value)}
              className="h-12 min-w-0 flex-1 bg-transparent text-sm text-[var(--wb-text-strong)] outline-none placeholder:text-[var(--wb-faint)]"
            />
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
            onConfirm={onDeleteConfirm}
            onKeep={onKeepWorktree}
            onDiscard={onDiscardWorktree}
            onCancel={onBack}
          />
        ) : null}
        {notice ? (
          <p className="px-3.5 pt-3 text-xs text-[var(--wb-muted)]" data-command-notice>
            {notice}
          </p>
        ) : null}
        {drill === "commands" || drill === "chats" || drill === "files" ? (
          <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-2" data-command-list>
            {rows.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-[var(--wb-muted)]" data-command-empty>
                {emptyLabel}
              </p>
            ) : (
              <RowList rows={rows} active={active} query={query} onActive={onActive} onRun={onRun} />
            )}
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
  onActive,
  onRun,
}: {
  rows: readonly PaletteRow[];
  active: number;
  query: string;
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
        <section key={section.group} data-command-menu-search-section={section.group} className="pb-1">
          <h2 className="px-3.5 pb-1 pt-2 text-[11px] font-medium text-[var(--wb-faint)]">{section.label}</h2>
          {section.rows.map(({ row, index }) => {
            const selected = index === active;
            return (
              <button
                key={row.key}
                type="button"
                role="option"
                aria-selected={selected}
                data-command-row={row.commandId ?? row.sessionId ?? row.filePath}
                data-command-active={selected ? "true" : "false"}
                className={
                  selected
                    ? "flex h-9 w-full items-center gap-3 bg-[var(--wb-hover-strong)] px-3.5 text-left text-sm text-[var(--wb-text-strong)]"
                    : "flex h-9 w-full items-center gap-3 px-3.5 text-left text-sm text-[var(--wb-text)] hover:bg-[var(--wb-hover)]"
                }
                onMouseEnter={() => onActive(index)}
                onClick={() => onRun(index)}
              >
                <span className="min-w-0 flex-1 truncate">
                  {row.kind === "command" ? row.label : highlight(row.label, query)}
                </span>
                {row.detail ? (
                  <span className="w-[46%] shrink-0 truncate text-right text-xs text-[var(--wb-faint)]" data-command-detail>
                    {row.detail}
                  </span>
                ) : null}
                {row.shortcut ? (
                  <span className="shrink-0 text-xs text-[var(--wb-faint)]" data-command-shortcut>
                    {row.shortcut}
                  </span>
                ) : null}
              </button>
            );
          })}
        </section>
      ))}
    </>
  );
}

function highlight(label: string, query: string): ReactNode {
  const needle = query.trim();
  if (!needle) return label;
  const at = label.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0) return label;
  return (
    <>
      {label.slice(0, at)}
      <mark className="bg-transparent font-medium text-[var(--wb-accent)] underline decoration-[var(--wb-accent)]/60 underline-offset-2">
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
      <p className="text-sm text-[var(--wb-muted)]">{COPY.renameDescription}</p>
      <input
        ref={inputRef}
        aria-label={COPY.renameAria}
        placeholder={COPY.renamePlaceholder}
        value={title}
        onChange={(event) => onTitle(event.target.value)}
        className="h-9 w-full rounded-lg border border-[var(--wb-border-strong)] bg-[var(--wb-well)] px-3 text-sm text-[var(--wb-text-strong)] outline-none focus:border-[var(--wb-accent)] focus:ring-2 focus:ring-[var(--wb-accent)]/20"
      />
      {error ? (
        <p className="rounded-lg border border-[var(--wb-danger-border)] bg-[var(--wb-danger-bg)] px-3 py-2 text-xs text-[var(--wb-danger-text)]">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          className="rounded-lg px-3 py-1.5 text-sm text-[var(--wb-muted)] transition-colors hover:bg-[var(--wb-hover)] hover:text-[var(--wb-text-strong)]"
          onClick={onCancel}
        >
          {COPY.cancel}
        </button>
        <button
          type="button"
          disabled={!title.trim()}
          className="rounded-lg bg-[var(--wb-send-bg)] px-3 py-1.5 text-sm font-medium text-[var(--wb-send-fg)] transition-opacity hover:opacity-90 disabled:opacity-40"
          onClick={onSubmit}
        >
          {COPY.save}
        </button>
      </div>
    </div>
  );
}

function DeleteDrill({
  error,
  dirtyWorktree,
  ready,
  onConfirm,
  onKeep,
  onDiscard,
  onCancel,
}: {
  error: string | null;
  dirtyWorktree: boolean;
  ready: boolean;
  onConfirm: () => void;
  onKeep?: () => void;
  onDiscard?: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="space-y-3 px-4 py-4" data-command-drill="delete" data-dirty-worktree={dirtyWorktree ? "true" : "false"}>
      <p className="text-sm text-[var(--wb-muted)]">
        {dirtyWorktree ? COPY.deleteDirtyWorktree : COPY.deleteDescription}
      </p>
      {error ? (
        <p className="rounded-lg border border-[var(--wb-danger-border)] bg-[var(--wb-danger-bg)] px-3 py-2 text-xs text-[var(--wb-danger-text)]">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          className="rounded-lg px-3 py-1.5 text-sm text-[var(--wb-muted)] transition-colors hover:bg-[var(--wb-hover)] hover:text-[var(--wb-text-strong)]"
          onClick={onCancel}
        >
          {COPY.cancel}
        </button>
        {dirtyWorktree ? (
          <button
            type="button"
            disabled={!ready}
            className="rounded-lg border border-[var(--wb-border-strong)] px-3 py-1.5 text-sm text-[var(--wb-text)] transition-colors hover:bg-[var(--wb-hover)] hover:text-[var(--wb-text-strong)] disabled:opacity-40"
            onClick={onKeep}
          >
            {COPY.keepWorktree}
          </button>
        ) : null}
        <button
          type="button"
          disabled={!ready}
          className="rounded-lg bg-[var(--wb-danger-solid)] px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-[var(--wb-danger-solid-hover)] disabled:opacity-40"
          onClick={dirtyWorktree ? onDiscard : onConfirm}
        >
          {dirtyWorktree ? COPY.discardWorktree : COPY.deleteAction}
        </button>
      </div>
    </div>
  );
}
