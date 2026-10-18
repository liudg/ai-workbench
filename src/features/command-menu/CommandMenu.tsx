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

export type PaletteDrill = "commands" | "chats" | "rename" | "delete";

export function CommandMenu({
  query,
  rows,
  active,
  drill,
  renameTitle,
  renameError,
  deleteError,
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
  const placeholder = searchingChats ? COPY.chatPlaceholder : COPY.placeholder;

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
      if (drill === "commands") onClose();
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
    searchingChats && query.trim().length === 0 ? COPY.noChats : COPY.empty;

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/50 pt-[12vh]"
      data-command-menu
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-label={COPY.title}
        aria-describedby="command-menu-description"
        onKeyDown={onKeyDown}
        className="flex max-h-[min(560px,70vh)] w-[min(640px,94vw)] flex-col overflow-hidden rounded-xl border border-[#2e2e2e] bg-[#1a1a1a] shadow-2xl shadow-black/50"
      >
        <p id="command-menu-description" className="sr-only">
          {COPY.description}
        </p>
        <div className="flex items-center gap-2 border-b border-[#2a2a2a] px-3">
          {drill !== "commands" ? (
            <button
              type="button"
              className="shrink-0 text-xs text-[#8d8d8d] hover:text-[#e8e8e8]"
              onClick={onBack}
            >
              {COPY.back}
            </button>
          ) : null}
          {drill === "rename" || drill === "delete" ? (
            <span className="py-3 text-sm text-[#e8e8e8]">
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
              className="h-12 min-w-0 flex-1 bg-transparent text-sm text-[#e8e8e8] outline-none placeholder:text-[#6d6d6d]"
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
        {drill === "commands" || drill === "chats" ? (
          <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-2" data-command-list>
            {rows.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-[#8d8d8d]" data-command-empty>
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
          <h2 className="px-3 pb-1 pt-2 text-[11px] text-[#777]">{section.label}</h2>
          {section.rows.map(({ row, index }) => {
            const selected = index === active;
            return (
              <button
                key={row.key}
                type="button"
                role="option"
                aria-selected={selected}
                data-command-row={row.commandId ?? row.sessionId}
                data-command-active={selected ? "true" : "false"}
                className={
                  selected
                    ? "flex h-9 w-full items-center gap-3 bg-white/10 px-3 text-left text-sm text-[#f3f3f3]"
                    : "flex h-9 w-full items-center gap-3 px-3 text-left text-sm text-[#d4d4d4] hover:bg-white/5"
                }
                onMouseEnter={() => onActive(index)}
                onClick={() => onRun(index)}
              >
                <span className="min-w-0 flex-1 truncate">
                  {row.kind === "chat" ? highlight(row.label, query) : row.label}
                </span>
                {row.shortcut ? (
                  <span className="shrink-0 text-xs text-[#777]" data-command-shortcut>
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
      <mark className="bg-transparent text-[#f5f5f5] underline decoration-[#4f8dff]/70">
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
      <p className="text-sm text-[#a3a3a3]">{COPY.renameDescription}</p>
      <input
        ref={inputRef}
        aria-label={COPY.renameAria}
        placeholder={COPY.renamePlaceholder}
        value={title}
        onChange={(event) => onTitle(event.target.value)}
        className="h-9 w-full rounded-md border border-[#3a3a3a] bg-[#111] px-3 text-sm text-[#f3f3f3] outline-none focus:border-[#666]"
      />
      {error ? <p className="text-sm text-red-300">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <button type="button" className="rounded-md px-3 py-1.5 text-sm text-[#ccc] hover:bg-white/5" onClick={onCancel}>
          {COPY.cancel}
        </button>
        <button
          type="button"
          disabled={!title.trim()}
          className="rounded-md bg-[#e8e8e8] px-3 py-1.5 text-sm text-[#111] disabled:opacity-40"
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
      <p className="text-sm text-[#a3a3a3]">
        {dirtyWorktree ? COPY.deleteDirtyWorktree : COPY.deleteDescription}
      </p>
      {error ? <p className="text-sm text-red-300">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <button type="button" className="rounded-md px-3 py-1.5 text-sm text-[#ccc] hover:bg-white/5" onClick={onCancel}>
          {COPY.cancel}
        </button>
        {dirtyWorktree ? (
          <button
            type="button"
            disabled={!ready}
            className="rounded-md px-3 py-1.5 text-sm text-[#ccc] hover:bg-white/5 disabled:opacity-40"
            onClick={onKeep}
          >
            {COPY.keepWorktree}
          </button>
        ) : null}
        <button
          type="button"
          disabled={!ready}
          className="rounded-md bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-500 disabled:opacity-40"
          onClick={dirtyWorktree ? onDiscard : onConfirm}
        >
          {dirtyWorktree ? COPY.discardWorktree : COPY.deleteAction}
        </button>
      </div>
    </div>
  );
}
