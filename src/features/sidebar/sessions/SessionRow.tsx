import { useCallback, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Ellipsis, Pin } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  worktreeDeleteFlags,
  worktreeDeleteIsDirty,
  type WorktreeDeletePreview,
} from "@/lib/worktree-delete";
import { cn } from "@/lib/utils";
import { AttentionPill, attentionPill } from "@/shared/attention";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { SessionAgentIcon } from "@/shared/agent/SessionAgentIcon";
import { FixedMenu } from "../FixedMenu";
import type { SidebarTask } from "../sidebar-task";
import { relativeSessionTime } from "@/shared/format/relative-time";
import { DeleteSessionDialog } from "./DeleteSessionDialog";
import { shouldSubmitRename } from "./rename-submit";
import { sessionMenuItems, type SessionMenuAction } from "./session-menu";
import { SubmenuItem } from "./SubmenuItem";
import { useSessionRow } from "./use-session-row";
import type { AgentKind } from "@/types";

export function SessionRow({
  task,
  active,
  now,
  depth,
  subtasks,
  collapsed,
  onToggle,
}: {
  task: SidebarTask;
  active: boolean;
  now: number;
  /** 1 是挂在父任务下的子任务。 */
  depth: 0 | 1;
  /** 下面挂着几个子任务。有子任务时可以折叠。 */
  subtasks: number;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const row = useSessionRow(task);

  const [menuOpen, setMenuOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [title, setTitle] = useState(task.title);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deletePreview, setDeletePreview] = useState<WorktreeDeletePreview | null>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const items = sessionMenuItems({ pinned: task.pinned, archived: task.archived, forks: row.forks });

  const run = (action: SessionMenuAction, agent?: AgentKind) => {
    closeMenu();
    if (action === "fork") {
      row.fork(agent);
      return;
    }
    if (action === "rename") {
      setTitle(task.title);
      setRenameError(null);
      setRenameOpen(true);
      return;
    }
    if (action === "pin") {
      row.togglePinned();
      return;
    }
    if (action === "archive") {
      row.toggleArchived();
      return;
    }
    if (action === "copy-markdown" || action === "copy-workdir") {
      row.copy(action === "copy-markdown" ? "markdown" : "workdir");
      return;
    }
    if (action !== "delete") return;
    setDeleteError(null);
    setDeletePreview(null);
    void row.loadDeletePreview().then((preview) => {
      setDeletePreview(preview);
      setDeleteOpen(true);
    });
  };

  const finishDelete = (action: "delete" | "keep-worktree" | "discard-worktree") => {
    void row.remove(worktreeDeleteFlags(action, deletePreview)).then((ok) => {
      if (ok) setDeleteOpen(false);
      else setDeleteError(DESKTOP_ZH.deleteSessionError);
    });
  };

  const submitRename = () => {
    if (!title.trim()) return;
    void row.rename(title).then((ok) => {
      if (ok) setRenameOpen(false);
      else setRenameError(DESKTOP_ZH.renameSaveError);
    });
  };

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        data-session-row=""
        data-session-id={task.id}
        data-agent={task.agent}
        data-active={active ? "true" : "false"}
        data-pinned={task.pinned ? "true" : "false"}
        data-archived={task.archived ? "true" : "false"}
        data-subtask={depth === 1 ? "true" : undefined}
        className={cn(
          "group relative flex h-full w-full items-center gap-1.5 rounded-md pr-2 text-left text-[11.5px] leading-none",
          depth === 1 ? "pl-[52px]" : "pl-9",
          active
            ? "bg-[#222] text-[#f3f3f3]"
            : "text-[#bdbdbd] hover:bg-white/[0.04] hover:text-[#e8e8e8]",
        )}
        onClick={row.select}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setMenuOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            row.select();
          }
        }}
      >
        {subtasks > 0 && (
          <button
            type="button"
            className="absolute left-4 flex h-4 w-4 items-center justify-center rounded text-[#777] hover:text-[#e8e8e8]"
            aria-label={collapsed ? `展开 ${subtasks} 个子任务` : "收起子任务"}
            aria-expanded={!collapsed}
            onClick={(event) => {
              event.stopPropagation();
              onToggle();
            }}
          >
            {collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>
        )}
        <SessionAgentIcon identity={row.identity} />
        <span className="min-w-0 flex-1 truncate">{task.title}</span>
        <AttentionPill pill={attentionPill(task.attention)} />
        {task.pinned && <Pin className="h-3 w-3 shrink-0 text-[#8a8a8a]" aria-hidden="true" />}
        <span className="relative flex w-16 shrink-0 justify-end text-right tabular-nums">
          <span
            className={cn(
              "text-[10px] text-[#666]",
              "group-hover:invisible group-focus-within:invisible",
              menuOpen && "invisible",
            )}
          >
            {relativeSessionTime(task.updatedAt, now)}
          </span>
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
        </span>
      </div>
      <FixedMenu
        open={menuOpen}
        anchorRef={anchorRef}
        onClose={closeMenu}
        label="聊天操作"
        className="w-44 rounded-xl border border-zinc-700/80 bg-zinc-900 py-1 shadow-xl shadow-black/50"
      >
        {items.map((item) =>
          item.children ? (
            <SubmenuItem key={item.key} item={item} onSelect={run} />
          ) : (
            <MenuItem
              key={item.key}
              action={item.id}
              label={item.label}
              danger={item.danger}
              onSelect={() => run(item.id, item.agent)}
            />
          ),
        )}
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
            className="h-9 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-100 outline-none focus:border-zinc-500"
          />
          {renameError && <p className="text-sm text-red-300">{renameError}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameOpen(false)}>
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

function MenuItem({
  action,
  label,
  onSelect,
  danger = false,
}: {
  action: SessionMenuAction;
  label: string;
  onSelect: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      data-session-action={action}
      className={cn(
        "block w-full px-3 py-2 text-left text-sm hover:bg-zinc-800",
        danger ? "text-red-400" : "text-zinc-100",
      )}
      onClick={(event) => {
        event.stopPropagation();
        onSelect();
      }}
    >
      {label}
    </button>
  );
}
