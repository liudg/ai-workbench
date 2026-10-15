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
import { cn } from "@/lib/utils";
import type { Session } from "@/types";
import { FixedMenu } from "../FixedMenu";
import { SessionAgentIcon } from "./SessionAgentIcon";
import { SessionStatusDot } from "./SessionStatusDot";
import { relativeSessionTime } from "./relative-time";
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
  } = useSessionRow(session);
  const showUnread = unreadFinished && !active;

  const [menuOpen, setMenuOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [title, setTitle] = useState(session.title);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const archived = Boolean(session.archived);
  const items = sessionMenuItems({ caps, pinned, archived });

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
    setDeleteOpen(true);
  };

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        data-session-row=""
        data-session-id={session.id}
        data-agent={session.agent}
        data-active={active ? "true" : "false"}
        data-pinned={pinned ? "true" : "false"}
        data-archived={archived ? "true" : "false"}
        className={cn(
          "group flex h-full w-full items-center gap-1.5 rounded-md pl-9 pr-2 text-left text-[11.5px] leading-none",
          active
            ? "bg-[#222] text-[#f3f3f3]"
            : "text-[#bdbdbd] hover:bg-white/[0.04] hover:text-[#e8e8e8]",
        )}
        onClick={() => void selectSession(projectId, session.id)}
        onKeyDown={(event) => {
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
          <span className="ml-1 shrink-0 rounded bg-amber-400/15 px-1.5 py-0.5 text-[10px] leading-4 text-amber-200">
            只读
          </span>
        )}
        <SessionStatusDot status={session.status} />
        {pinned && <Pin className="h-3 w-3 shrink-0 text-[#8a8a8a]" aria-hidden="true" />}
        <span className="relative flex w-16 shrink-0 justify-end text-right tabular-nums">
          <span
            className={cn(
              "text-[10px] text-[#666]",
              "group-hover:invisible group-focus-within:invisible",
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
                "absolute inset-0 hidden items-center justify-end text-zinc-300 group-hover:flex group-focus-within:flex",
                menuOpen && "flex",
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
        className="w-44 rounded-xl border border-zinc-700/80 bg-zinc-900 py-1 shadow-xl shadow-black/50"
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
          <input
            aria-label="聊天标题"
            placeholder="添加标题…"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className="h-9 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-100 outline-none focus:border-zinc-500"
          />
          {renameError && <p className="text-sm text-red-300">{renameError}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameOpen(false)}>
              取消
            </Button>
            <Button
              disabled={!title.trim()}
              onClick={() => {
                void renameSession(session.id, title).then((ok) => {
                  if (ok) setRenameOpen(false);
                  else setRenameError("无法保存更改。请重试");
                });
              }}
            >
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>要删除任务？</DialogTitle>
            <DialogDescription>
              这将永久删除该任务及其子智能体任务。此操作无法撤销。
            </DialogDescription>
          </DialogHeader>
          {deleteError && <p className="text-sm text-red-300">{deleteError}</p>}
          <DialogFooter>
            <Button variant="outline" autoFocus onClick={() => setDeleteOpen(false)}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                void deleteSession(projectId, session.id).then((ok) => {
                  if (ok) setDeleteOpen(false);
                  else setDeleteError("无法删除任务。请重试。");
                });
              }}
            >
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function UnreadFinishedMark() {
  return (
    <span
      data-unread-finished=""
      title="未读"
      aria-label="未读"
      className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[#4f8dff]"
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
        "block w-full px-3 py-2 text-left text-sm hover:bg-zinc-800 disabled:opacity-60",
        danger ? "text-red-400" : "text-zinc-100",
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
