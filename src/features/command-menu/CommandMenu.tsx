import {
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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
      className="fixed inset-0 z-[60] flex items-start justify-center bg-wb-backdrop pt-[12vh] backdrop-blur-[2px]"
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
        className="wb-popover flex max-h-[min(560px,70vh)] w-[min(640px,94vw)] flex-col overflow-hidden rounded-2xl"
      >
        <p id="command-menu-description" className="sr-only">
          {COPY.description}
        </p>
        <div className="flex items-center gap-2 border-b border-wb-border px-3.5">
          {drill !== "commands" ? (
            <button
              type="button"
              className="shrink-0 rounded-md px-2 py-1 text-xs text-wb-fg-2 transition-colors hover:bg-wb-hover hover:text-wb-fg"
              onClick={onBack}
            >
              {COPY.back}
            </button>
          ) : null}
          {drill === "rename" || drill === "delete" ? (
            <span className="py-3 text-sm font-medium text-wb-fg">
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
              className="h-12 min-w-0 flex-1 bg-transparent text-sm text-wb-fg outline-none placeholder:text-wb-dim"
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
          <p className="px-3.5 pt-3 text-xs text-wb-fg-2" data-command-notice>
            {notice}
          </p>
        ) : null}
        {drill === "commands" || drill === "chats" || drill === "files" ? (
          <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-1.5 py-2" data-command-list>
            {rows.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-wb-fg-3" data-command-empty>
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
          <h2 className="px-2.5 pb-1 pt-2 text-[11px] font-medium text-wb-fg-3">{section.label}</h2>
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
                    ? "flex h-9 w-full items-center gap-3 rounded-lg bg-wb-active px-2.5 text-left text-sm text-wb-fg"
                    : "flex h-9 w-full items-center gap-3 rounded-lg px-2.5 text-left text-sm text-wb-fg-2 transition-colors hover:bg-wb-hover hover:text-wb-fg"
                }
                onMouseEnter={() => onActive(index)}
                onClick={() => onRun(index)}
              >
                <span className="min-w-0 flex-1 truncate">
                  {row.kind === "command" ? row.label : highlight(row.label, query)}
                </span>
                {row.detail ? (
                  <span className="w-[46%] shrink-0 truncate text-right text-xs text-wb-fg-3" data-command-detail>
                    {row.detail}
                  </span>
                ) : null}
                {row.shortcut ? (
                  <span className="shrink-0 font-mono text-[11px] text-wb-fg-3" data-command-shortcut>
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
      <p className="text-sm text-wb-fg-2">
        {dirtyWorktree ? COPY.deleteDirtyWorktree : COPY.deleteDescription}
      </p>
      {error ? <p className="text-sm text-wb-danger">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
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
