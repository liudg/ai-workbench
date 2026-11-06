import { useEffect, useRef, useState } from "react";

import { OPEN_THREAD_FIND } from "@/features/chat/find/use-thread-find";
import { FileSearchDialog } from "@/features/panel/files/FileSearchDialog";
import { currentSession, tasksApi } from "@/features/tasks";
import {
  worktreeDeleteFlags,
  worktreeDeleteIsDirty,
  type WorktreeDeletePreview,
} from "@/lib/worktree-delete";
import { showError } from "@/shared/shell/error-banner";
import {
  leaveTask,
  openBoard,
  openNewSession,
  openProjectDialog,
  openSettings,
  openTask,
} from "@/shared/shell/navigation";
import { toggleSidebar } from "@/shared/shell/sidebar-open";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import type { AgentKind } from "@/types";

import { buildPaletteRows, type PaletteCommandId } from "./commands";
import { CommandMenu, type PaletteDrill } from "./CommandMenu";
import { COMMAND_MENU_COPY as COPY } from "./copy";
import { OPEN_COMMAND_MENU } from "./open-event";
import { useCommandMenuState } from "./use-command-menu-state";
import { fileRows } from "./file-rows";
import {
  deleteShortcutMenu,
  isDeleteChord,
  isNewThreadChord,
  isOpenChord,
  isQuickOpenChord,
  isSidebarChord,
  isSideChatChord,
  isTerminalChord,
} from "./keyboard";
import { useQuickOpen } from "./useQuickOpen";

/** 挂在会话视图的面板里，文件类命令用面板的数据来源；没有面板时只有通用命令。 */
export function CommandMenuHost() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [drill, setDrill] = useState<PaletteDrill>("commands");
  const [active, setActive] = useState(0);
  const [renameTitle, setRenameTitle] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [fileNotice, setFileNotice] = useState<string | null>(null);
  const [deletePreview, setDeletePreview] = useState<WorktreeDeletePreview | null | undefined>(undefined);
  const [fileSearchOpen, setFileSearchOpen] = useState(false);

  const { view, sessions, task, project, panel, changes, forkTargets, nextAttention } = useCommandMenuState();
  const session = task ? (currentSession(task) ?? null) : null;
  const quickScope = session ? { sessionId: session.id } : project ? { projectId: project.id } : null;

  const input = {
    query,
    mode: drill === "chats" ? ("chats" as const) : ("commands" as const),
    sessions,
    activeSessionId: task?.id ?? null,
    changes,
    canNewThread: Boolean(project),
    canStandalone: true,
    canSearchFiles: Boolean(panel && quickScope),
    hasPanel: Boolean(panel),
    canSideChat: Boolean(panel?.openSideChat),
    canFind: view.kind !== "none",
    forkTargets,
    hasNextAttention: nextAttention !== null,
  };
  const filesOpen = open && drill === "files";
  const quick = useQuickOpen(quickScope, query, filesOpen);
  const commandRows = buildPaletteRows(input);
  const rows = filesOpen ? fileRows(quick.paths) : commandRows;
  const fileEmpty =
    quick.phase === "no-project"
      ? COPY.noProject
      : quick.phase === "error"
        ? COPY.fileError
        : quick.phase === "loading"
          ? COPY.filePending
          : COPY.empty;
  const safeActive = rows.length === 0 ? 0 : Math.min(active, rows.length - 1);

  const close = () => {
    setOpen(false);
    setQuery("");
    setDrill("commands");
    setActive(0);
    setRenameError(null);
    setDeleteError(null);
    setFileNotice(null);
  };

  const runCommand = (id: PaletteCommandId, agent?: AgentKind) => {
    if (id === "new-thread" && project) {
      openNewSession(project.id);
      close();
      return;
    }
    if (id === "new-standalone") {
      openNewSession(null);
      close();
      return;
    }
    if (id === "open-folder") {
      openProjectDialog("import");
      close();
      return;
    }
    if (id === "settings") {
      openSettings();
      close();
      return;
    }
    if (id === "board") {
      openBoard();
      close();
      return;
    }
    if (id === "next-attention" && nextAttention) {
      openTask(nextAttention.id, nextAttention.projectId ?? null);
      close();
      return;
    }
    if (id === "toggle-sidebar") {
      toggleSidebar();
      close();
      return;
    }
    if (id === "quick-open") {
      setDrill("files");
      setQuery("");
      setActive(0);
      setFileNotice(null);
      return;
    }
    if (id === "search-chats") {
      setDrill("chats");
      setQuery("");
      setActive(0);
      return;
    }
    if (id === "find-in-thread") {
      close();
      window.dispatchEvent(new CustomEvent(OPEN_THREAD_FIND));
      return;
    }
    if (id === "search-files" && panel) {
      setFileSearchOpen(true);
      close();
      return;
    }
    if (id === "toggle-terminal" && panel) {
      const terminalShown =
        panel.layout !== "chat" && panel.tabs.find((tab) => tab.id === panel.activeId)?.viewerId === "terminal";
      if (terminalShown) panel.hidePanel();
      else panel.openTerminal();
      close();
      return;
    }
    if (id === "toggle-side-chat" && panel?.openSideChat) {
      const sideShown =
        panel.layout !== "chat" && panel.tabs.find((tab) => tab.id === panel.activeId)?.viewerId === "side-chat";
      if (sideShown) panel.hidePanel();
      else {
        const recent = [panel.activeId, ...(panel.recentTabIds ?? []), ...panel.tabs.map((tab) => tab.id).reverse()]
          .map((id) => panel.tabs.find((tab) => tab.id === id && tab.viewerId === "side-chat" && tab.status !== "error"))
          .find(Boolean);
        if (recent) {
          panel.selectTab(recent.id);
          panel.showPanel();
        } else panel.openSideChat();
      }
      close();
      return;
    }
    if (!task) return;
    if (id === "pin") {
      void tasksApi.setTaskPinned(task.id, !task.pinned).catch(showError);
      close();
      return;
    }
    if (id === "archive") {
      const archived = Boolean(task.archivedAt);
      if (!archived) leaveTask(task.id);
      void tasksApi.archiveTask(task.id, !archived).catch(showError);
      close();
      return;
    }
    if (id === "fork") {
      close();
      void tasksApi.forkTask(task.id, agent).then((entry) => openTask(entry.id, entry.projectId ?? null), showError);
      return;
    }
    if (id === "rename") {
      setRenameTitle(task.title);
      setRenameError(null);
      setDrill("rename");
      return;
    }
    if (id === "delete") {
      setDeleteError(null);
      setDeletePreview(undefined);
      setDrill("delete");
      void tasksApi
        .deletePreview(task.id)
        .catch(() => null)
        .then(setDeletePreview);
      return;
    }
    if (!panel) return;
    const activeTab = panel.tabs.find((tab) => tab.id === panel.activeId);
    if (id === "toggle-files") {
      const showing = panel.layout !== "chat" && activeTab?.viewerId === "files";
      if (showing) panel.hidePanel();
      else panel.openFiles();
      close();
      return;
    }
    if (id === "toggle-changes") {
      const showing = panel.layout !== "chat" && activeTab?.viewerId === "diff";
      if (showing) panel.hidePanel();
      else panel.openDiff(`diff:${panel.sessionId}`, DESKTOP_ZH.changesTab, panel.sessionFiles);
      close();
    }
  };

  const runIndex = (index: number) => {
    const row = rows[index];
    if (!row) return;
    if (row.kind === "chat" && row.sessionId) {
      openTask(row.sessionId, row.projectId || null);
      close();
      return;
    }
    if (row.kind === "file" && row.filePath) {
      if (!panel) {
        setFileNotice(COPY.needSession);
        return;
      }
      panel.openHref(row.filePath);
      close();
      return;
    }
    if (row.commandId) runCommand(row.commandId, row.agent);
  };

  const actions = useRef({ input, runCommand, open, drill });
  actions.current = { input, runCommand, open, drill };

  useEffect(() => {
    const openMenu = () => {
      setOpen(true);
      setDrill("commands");
      setQuery("");
      setActive(0);
    };
    const onKey = (event: KeyboardEvent) => {
      const current = actions.current;
      if (isOpenChord(event)) {
        event.preventDefault();
        event.stopPropagation();
        setOpen((value) => !value);
        setDrill("commands");
        setQuery("");
        setActive(0);
        setFileNotice(null);
        return;
      }
      if (isQuickOpenChord(event)) {
        event.preventDefault();
        event.stopPropagation();
        const view = actions.current;
        if (view.open && view.drill === "files") {
          setOpen(false);
          setDrill("commands");
          setQuery("");
          setActive(0);
          setFileNotice(null);
          return;
        }
        setOpen(true);
        setDrill("files");
        setQuery("");
        setActive(0);
        setRenameError(null);
        setDeleteError(null);
        setFileNotice(null);
        return;
      }
      if (isSidebarChord(event)) {
        event.preventDefault();
        event.stopPropagation();
        toggleSidebar();
        return;
      }
      const visible = (id: PaletteCommandId) =>
        buildPaletteRows({ ...current.input, mode: "commands", query: "" }).some((row) => row.commandId === id);
      if (isTerminalChord(event) && visible("toggle-terminal")) {
        event.preventDefault();
        event.stopPropagation();
        current.runCommand("toggle-terminal");
        return;
      }
      if (isSideChatChord(event) && visible("toggle-side-chat")) {
        event.preventDefault();
        event.stopPropagation();
        current.runCommand("toggle-side-chat");
        return;
      }
      if (isNewThreadChord(event) && visible("new-thread")) {
        event.preventDefault();
        event.stopPropagation();
        current.runCommand("new-thread");
        return;
      }
      if (isDeleteChord(event) && visible("delete")) {
        event.preventDefault();
        event.stopPropagation();
        const menu = deleteShortcutMenu(current.open);
        setOpen(menu.open);
        setDrill(menu.drill);
        current.runCommand("delete");
      }
    };
    window.addEventListener(OPEN_COMMAND_MENU, openMenu);
    // 捕获阶段，输入框聚焦时也能接到。Enter、Esc、方向键和 Tab 不在这里处理。
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener(OPEN_COMMAND_MENU, openMenu);
      window.removeEventListener("keydown", onKey, true);
    };
  }, []);

  const submitRename = () => {
    if (!task || !renameTitle.trim()) return;
    void tasksApi.renameTask(task.id, renameTitle).then(close, () => setRenameError(COPY.renameError));
  };

  const confirmDelete = (action: "delete" | "keep-worktree" | "discard-worktree") => {
    if (!task || deletePreview === undefined) return;
    const flags = worktreeDeleteFlags(action, deletePreview);
    void tasksApi.removeTask(task.id, flags).then(
      () => {
        leaveTask(task.id);
        close();
      },
      () => setDeleteError(COPY.deleteError),
    );
  };

  return (
    <>
      {open ? (
        <CommandMenu
          query={query}
          rows={rows}
          active={safeActive}
          drill={drill}
          renameTitle={renameTitle}
          renameError={renameError}
          deleteError={deleteError}
          notice={filesOpen ? fileNotice : null}
          emptyText={filesOpen ? fileEmpty : undefined}
          dirtyWorktree={worktreeDeleteIsDirty(deletePreview ?? null)}
          deleteReady={deletePreview !== undefined}
          onQuery={(value) => {
            setQuery(value);
            setActive(0);
            setFileNotice(null);
          }}
          onActive={setActive}
          onRun={runIndex}
          onClose={close}
          onBack={() => {
            setDrill("commands");
            setQuery("");
            setActive(0);
            setRenameError(null);
            setDeleteError(null);
            setFileNotice(null);
          }}
          onRenameTitle={setRenameTitle}
          onRenameSubmit={submitRename}
          onDeleteConfirm={() => confirmDelete("delete")}
          onKeepWorktree={() => confirmDelete("keep-worktree")}
          onDiscardWorktree={() => confirmDelete("discard-worktree")}
        />
      ) : null}
      {fileSearchOpen && panel ? (
        <FileSearchDialog
          projectId={panel.projectId}
          onClose={() => setFileSearchOpen(false)}
          onOpen={(path, line) => panel.openHref(path, line ?? undefined)}
        />
      ) : null}
    </>
  );
}
