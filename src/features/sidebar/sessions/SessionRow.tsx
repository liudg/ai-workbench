import { useCallback, useRef, useState, type ReactNode } from "react";
import { ChevronRight, Ellipsis } from "lucide-react";

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
import { useFixedMenu } from "../use-fixed-menu";
import { relativeSessionTime } from "./relative-time";
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
  const { selectSession, caps, busy, renameSession, forkSession, deleteSession } = useSessionRow(session);

  const [menuOpen, setMenuOpen] = useState(false);
  const [forkOpen, setForkOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [title, setTitle] = useState(session.title);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    setForkOpen(false);
  }, []);
  useFixedMenu(menuOpen, anchorRef, menuRef, closeMenu, "below");

  const canRename = Boolean(caps?.supports_rename);
  const canFork = Boolean(caps?.supports_fork);
  const canDelete = Boolean(caps?.supports_delete);
  const hasMenu = canRename || canFork || canDelete;

  const groups: Array<Array<{ key: string; node: ReactNode }>> = [];
  if (canRename) {
    groups.push([
      {
        key: "rename",
        node: (
          <MenuItem
            label="重命名聊天"
            onSelect={() => {
              closeMenu();
              setTitle(session.title);
              setRenameError(null);
              setRenameOpen(true);
            }}
          />
        ),
      },
    ]);
  }
  if (canFork) {
    groups.push([
      {
        key: "fork",
        node: (
          <div className="relative">
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-zinc-100 hover:bg-zinc-800"
              aria-expanded={forkOpen}
              onClick={(event) => {
                event.stopPropagation();
                setForkOpen((open) => !open);
              }}
            >
              分叉
              <ChevronRight className="h-3.5 w-3.5 text-zinc-500" />
            </button>
            {forkOpen && (
              <div className="absolute left-full top-0 z-10 ml-1 w-44 overflow-hidden rounded-xl border border-zinc-700/80 bg-zinc-900 py-1 shadow-xl shadow-black/50">
                <MenuItem
                  label={busy ? "正在创建聊天分支…" : "创建聊天分支"}
                  disabled={busy}
                  onSelect={() => {
                    closeMenu();
                    void forkSession(projectId, session.id);
                  }}
                />
              </div>
            )}
          </div>
        ),
      },
    ]);
  }
  const lifecycle: Array<{ key: string; node: ReactNode }> = [];
  if (canDelete) {
    lifecycle.push({
      key: "delete",
      node: (
        <MenuItem
          label="永久删除"
          danger
          onSelect={() => {
            closeMenu();
            setDeleteError(null);
            setDeleteOpen(true);
          }}
        />
      ),
    });
  }
  if (lifecycle.length > 0) groups.push(lifecycle);

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        className={cn(
          "group flex w-full items-center rounded-md py-1 pl-7 pr-2 text-left text-[13px] leading-5",
          active
            ? "text-zinc-100"
            : "text-zinc-400 hover:bg-zinc-800/40 hover:text-zinc-200",
          active && "hover:bg-zinc-800/40",
        )}
        onClick={() => void selectSession(projectId, session.id)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            void selectSession(projectId, session.id);
          }
        }}
      >
        <span className="min-w-0 flex-1 truncate">{session.title}</span>
        {readOnly && (
          <span className="ml-1 shrink-0 rounded bg-amber-400/15 px-1.5 py-0.5 text-[10px] leading-4 text-amber-200">
            只读
          </span>
        )}
        <span className="relative ml-2 w-16 shrink-0 text-right text-[11px] tabular-nums text-zinc-500">
          <span className={cn("group-hover:invisible group-focus-within:invisible", menuOpen && "invisible")}>
            {relativeSessionTime(session.updated_at, now)}
          </span>
          {hasMenu && (
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
      {menuOpen && hasMenu && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="聊天操作"
          className="fixed z-50 w-44 rounded-xl border border-zinc-700/80 bg-zinc-900 py-1 shadow-xl shadow-black/50"
          style={{ top: -9999, left: 8 }}
        >
          {groups.map((group, index) => (
            <div key={group[0]?.key ?? index} className={cn(index > 0 && "mt-1 border-t border-zinc-800 pt-1")}>
              {group.map((item) => (
                <div key={item.key}>{item.node}</div>
              ))}
            </div>
          ))}
        </div>
      )}

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>重命名聊天</DialogTitle>
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

function MenuItem({
  label,
  onSelect,
  danger = false,
  disabled = false,
}: {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
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
