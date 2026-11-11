import { useCallback, useRef, useState } from "react";
import { Ellipsis, Pin } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  worktreeDeleteFlags,
  worktreeDeleteIsDirty,
  type WorktreeDeletePreview,
} from "@/lib/worktree-delete";
import { cn } from "@/lib/utils";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { isPendingId } from "@/store/draft-session";
import type { Session } from "@/types";
import { FixedMenu } from "../FixedMenu";
import { SessionAgentIcon } from "@/shared/agent/SessionAgentIcon";
import { SessionStatusDot } from "./SessionStatusDot";
import { relativeSessionTime } from "./relative-time";
import { DeleteSessionDialog } from "./DeleteSessionDialog";
import { shouldSubmitRename } from "./rename-submit";
import { sessionMenuItems, type SessionMenuAction } from "./session-menu";
import { useSessionRow } from "./use-session-row";

export function SessionRow({
  projectId,
  session,
  active,
  readOnly,
  now,
}: {
  projectId: string;
  session: Session;
  active: boolean;
  readOnly: boolean;
  now: number;
}) {
  const {
    selectSession,
    caps,
    identity,
    busy,
    pinned,
    renameSession,
    togglePinnedSession,
    archiveSession,
    deleteSession,
    unreadFinished,
    previewWorktreeDelete,
  } = useSessionRow(session);
  const showUnread = unreadFinished && !active;

  const [menuOpen, setMenuOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [title, setTitle] = useState(session.title);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deletePreview, setDeletePreview] = useState<WorktreeDeletePreview | null>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const archived = Boolean(session.archived);
  const pending = isPendingId(session.id);
  const items = pending ? [] : sessionMenuItems({ caps, pinned, archived });

  const run = (action: SessionMenuAction) => {
    closeMenu();
    if (action === "rename") {
      setTitle(session.title);
      setRenameError(null);
      setRenameOpen(true);
      return;
    }
    if (action === "pin") {
      togglePinnedSession(session.id);
      return;
    }
    if (action === "archive") {
      void archiveSession(projectId, session.id, !archived);
      return;
    }
    setDeleteError(null);
    setDeletePreview(null);
    void previewWorktreeDelete().then((preview) => {
      setDeletePreview(preview);
      setDeleteOpen(true);
    });
  };

  const finishDelete = (action: "delete" | "keep-worktree" | "discard-worktree") => {
    void deleteSession(projectId, session.id, worktreeDeleteFlags(action, deletePreview)).then((ok) => {
      if (ok) setDeleteOpen(false);
      else setDeleteError(DESKTOP_ZH.deleteSessionError);
    });
  };

  const submitRename = () => {
    if (!title.trim()) return;
    void renameSession(session.id, title).then((ok) => {
      if (ok) setRenameOpen(false);
      else setRenameError(DESKTOP_ZH.renameSaveError);
    });
  };

  return (
    <>
      <div
        ref={rowRef}
        role="button"
        tabIndex={0}
        data-session-row=""
        data-session-id={session.id}
        data-session-pending={pending ? "true" : "false"}
        data-agent={session.agent}
        data-active={active ? "true" : "false"}
        data-pinned={pinned ? "true" : "false"}
        data-archived={archived ? "true" : "false"}
        className={cn(
          "group relative flex h-full w-full items-center gap-1.5 rounded-lg border pl-7 pr-2 text-left text-[11.5px] leading-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--wb-accent)]/35",
          active
            ? "border-[var(--wb-active-border)] bg-[var(--wb-active)] font-medium text-[var(--wb-text-strong)] shadow-[var(--wb-active-shadow)] before:pointer-events-none before:absolute before:bottom-1.5 before:left-[13px] before:top-1.5 before:w-[2.5px] before:rounded-full before:bg-[var(--wb-accent)]"
            : "border-transparent text-[var(--wb-muted)] hover:bg-[var(--wb-hover)] hover:text-[var(--wb-text-strong)]",
        )}
        onClick={() => void selectSession(projectId, session.id)}
        onContextMenu={(event) => {
          if (items.length === 0) return;
          event.preventDefault();
          event.stopPropagation();
          setMenuOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            void selectSession(projectId, session.id);
          }
        }}
      >
        <SessionAgentIcon identity={identity} />
        <span className="flex min-w-0 flex-1 items-center gap-1">
          <span className="min-w-0 truncate">{session.title}</span>
          {showUnread && <UnreadFinishedMark />}
        </span>
        {readOnly && (
          <span className="ml-1 shrink-0 rounded border border-[var(--wb-warn-border)] bg-[var(--wb-warn-bg)] px-1.5 py-0.5 text-[10px] leading-4 text-[var(--wb-warn-text)]">
            只读
          </span>
        )}
        <SessionStatusDot status={session.status} />
        {pinned && <Pin className="h-3 w-3 shrink-0 text-[var(--wb-faint)]" aria-hidden="true" />}
        <span className="relative flex w-14 shrink-0 items-center justify-end text-right tabular-nums">
          <span
            className={cn(
              "text-[10px] text-[var(--wb-faint)]",
              items.length > 0 && "group-hover:invisible group-focus-within:invisible",
              menuOpen && "invisible",
            )}
          >
            {relativeSessionTime(session.updated_at, now)}
          </span>
          {items.length > 0 && (
            <button
              ref={anchorRef}
              type="button"
              className={cn(
                "absolute right-0 hidden h-6 w-6 items-center justify-center rounded text-[var(--wb-muted)] transition-colors hover:bg-[var(--wb-hover-strong)] hover:text-[var(--wb-text-strong)] focus-visible:flex focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--wb-accent)]/35 group-hover:flex group-focus-within:flex",
                menuOpen && "flex bg-[var(--wb-hover-strong)] text-[var(--wb-text-strong)]",
              )}
              aria-label="聊天操作"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={(event) => {
                event.stopPropagation();
                setMenuOpen((open) => !open);
              }}
            >
              <Ellipsis className="h-4 w-4" />
            </button>
          )}
        </span>
      </div>
      <FixedMenu
        open={menuOpen && items.length > 0}
        anchorRef={anchorRef}
        onClose={closeMenu}
        label="聊天操作"
        className="w-44 rounded-xl border border-[var(--wb-border-strong)] bg-[var(--wb-elev)] py-1 shadow-[var(--wb-float-shadow)]"
      >
        {items.map((item) => (
          <MenuItem
            key={item.id}
            action={item.id}
            label={item.label}
            danger={item.danger}
            disabled={busy && item.id === "archive"}
            onSelect={() => run(item.id)}
          />
        ))}
      </FixedMenu>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>重命名</DialogTitle>
            <DialogDescription>保持简短且易于识别</DialogDescription>
          </DialogHeader>
          <Input
            aria-label="聊天标题"
            placeholder="添加标题…"
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (
                !shouldSubmitRename({
                  key: event.key,
                  composing: event.nativeEvent.isComposing,
                  keyCode: event.keyCode,
                  title,
                })
              ) {
                return;
              }
              event.preventDefault();
              submitRename();
            }}
          />
          {renameError && (
            <p className="rounded-lg border border-[var(--wb-danger-border)] bg-[var(--wb-danger-bg)] px-3 py-2 text-xs text-[var(--wb-danger-text)]">
              {renameError}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRenameOpen(false)}>
              取消
            </Button>
            <Button disabled={!title.trim()} onClick={submitRename}>
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DeleteSessionDialog
        open={deleteOpen}
        dirtyWorktree={worktreeDeleteIsDirty(deletePreview)}
        error={deleteError}
        onOpenChange={setDeleteOpen}
        onDelete={() => finishDelete("delete")}
        onKeepWorktree={() => finishDelete("keep-worktree")}
        onDiscardWorktree={() => finishDelete("discard-worktree")}
      />
    </>
  );
}

function UnreadFinishedMark() {
  return (
    <span
      data-unread-finished=""
      title="未读"
      aria-label="未读"
      className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--wb-accent)]"
    />
  );
}

function MenuItem({
  action,
  label,
  onSelect,
  danger = false,
  disabled = false,
}: {
  action: SessionMenuAction;
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      data-session-action={action}
      disabled={disabled}
      className={cn(
        "block w-full px-3 py-2 text-left text-sm transition-colors hover:bg-[var(--wb-hover)] focus-visible:bg-[var(--wb-hover)] focus-visible:outline-none disabled:opacity-60",
        danger ? "text-[var(--wb-danger-text)]" : "text-[var(--wb-text-strong)]",
      )}
      onClick={(event) => {
        event.stopPropagation();
        if (!disabled) onSelect();
      }}
    >
      {label}
    </button>
  );
}
