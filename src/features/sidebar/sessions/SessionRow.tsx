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
import { Input } from "@/components/ui/input";
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
  last,
  subtasks,
  collapsed,
  onToggle,
}: {
  task: SidebarTask;
  active: boolean;
  now: number;
  /** 1 是挂在父任务下的子任务。 */
  depth: 0 | 1;
  /** 是父任务下最后一个子任务，竖线到这里收尾。 */
  last: boolean;
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
          "group relative flex h-full w-full items-center gap-1.5 rounded-lg pr-2 text-left text-xs leading-none transition-colors",
          depth === 1 ? "pl-[48px]" : "pl-8",
          active
            ? "bg-wb-active font-medium text-wb-fg"
            : "text-wb-fg-2 hover:bg-wb-hover hover:text-wb-fg",
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
        {depth === 1 && (
          <span
            aria-hidden="true"
            data-subtask-rail={last ? "last" : "middle"}
            className={cn(
              "pointer-events-none absolute left-10 top-0 border-wb-border-strong",
              last ? "h-1/2 w-1.5 rounded-bl-[5px] border-b border-l" : "bottom-0 border-l",
            )}
          />
        )}
        {subtasks > 0 && (
          <button
            type="button"
            className="absolute left-3.5 flex h-4 w-4 items-center justify-center rounded text-wb-fg-3 hover:text-wb-fg"
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
        {task.pinned && <Pin className="h-3 w-3 shrink-0 text-wb-fg-3" aria-hidden="true" />}
        <span className="relative flex w-14 shrink-0 justify-end text-right tabular-nums">
          <span
            className={cn(
              "text-[10px] text-wb-fg-3",
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
              "absolute inset-0 hidden items-center justify-end text-wb-fg-2 group-hover:flex group-focus-within:flex",
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
        className="w-44"
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
            <DialogTitle>重命名任务</DialogTitle>
            <DialogDescription>输入简短标题以便识别</DialogDescription>
          </DialogHeader>
          <Input
            aria-label="聊天标题"
            placeholder="任务标题…"
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
          {renameError && <p className="text-xs text-wb-danger">{renameError}</p>}
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
        "block w-full rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors hover:bg-wb-hover",
        danger ? "text-wb-danger" : "text-wb-fg",
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
