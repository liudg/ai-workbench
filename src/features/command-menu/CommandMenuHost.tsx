import { useEffect, useRef, useState } from "react";

import { OPEN_THREAD_FIND } from "@/features/chat";
import { FileSearchDialog } from "@/features/panel";
import {
  computeVisibleSidebarTasks,
  getSidebarViewState,
  stepVisibleSidebarTask,
} from "@/features/sidebar";
import { currentSession, tasksApi, useTaskSearchHits } from "@/features/tasks";
import { canCheckUpdates, recheckUpdates } from "@/features/updates";
import {
  worktreeDeleteFlags,
  worktreeDeleteIsDirty,
  type WorktreeDeletePreview,
} from "@/lib/worktree-delete";
import {
  buildWhenContext,
  useKeybindingsTopicSync,
  useResolvedKeybindings,
} from "@/shared/keybindings";
import { showError } from "@/shared/shell/error-banner";
import {
  closeBoard,
  leaveTask,
  openBoard,
  openNewSession,
  openProjectDialog,
  openSettings,
  openTask,
} from "@/shared/shell/navigation";
import { toggleSidebar } from "@/shared/shell/sidebar-open";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { toggleTheme } from "@/shared/theme";
import type { AgentKind } from "@/types";

import { buildPaletteRows, type PaletteCommandId } from "./commands";
import { CommandMenu, type PaletteDrill } from "./CommandMenu";
import { COMMAND_MENU_COPY as COPY } from "./copy";
import { fileRows } from "./file-rows";
import { deleteShortcutMenu, parseSessionJumpIndex, resolveGlobalCommand } from "./keyboard";
import { OPEN_COMMAND_MENU } from "./open-event";
import { useCommandMenuState } from "./use-command-menu-state";
import { useQuickOpen } from "./useQuickOpen";

const COMMAND_MENU_SEARCH_LIMIT = 20;

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

  useKeybindingsTopicSync();
  const resolvedKeybindings = useResolvedKeybindings();

  const {
    view,
    settingsOpen,
    boardOpen,
    tasks,
    projects,
    sessions,
    task,
    project,
    panel,
    changes,
    forkTargets,
    nextAttention,
  } = useCommandMenuState();
  const session = task ? (currentSession(task) ?? null) : null;
  const quickScope = session ? { sessionId: session.id } : project ? { projectId: project.id } : null;
  const activeVisibleTaskId = !settingsOpen && !boardOpen && view.kind === "task" ? view.taskId : null;
  const visibleSidebarTasks = computeVisibleSidebarTasks(projects, tasks, getSidebarViewState());
  const messageSearchEnabled = open && (drill === "commands" || drill === "chats");
  const taskSearch = useTaskSearchHits(query, {
    enabled: messageSearchEnabled,
    includeArchived: true,
    limit: COMMAND_MENU_SEARCH_LIMIT,
  });

  const input = {
    query,
    mode: drill === "chats" ? ("chats" as const) : ("commands" as const),
    sessions,
    projects,
    searchHits: taskSearch.hits,
    activeSessionId: task?.id ?? null,
    changes,
    canNewThread: Boolean(project),
    canStandalone: true,
    canSearchFiles: Boolean(panel && quickScope),
    canCheckUpdates,
    hasPanel: Boolean(panel),
    canSideChat: Boolean(panel?.openSideChat),
    canFind: view.kind !== "none",
    forkTargets,
    hasNextAttention: nextAttention !== null,
    canSwitchSession: visibleSidebarTasks.length > 0,
    keybindings: resolvedKeybindings,
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

  const switchVisibleSession = (direction: -1 | 1): boolean => {
    const visibleTasks = computeVisibleSidebarTasks(projects, tasks, getSidebarViewState());
    const target = stepVisibleSidebarTask(visibleTasks, activeVisibleTaskId, direction);
    if (!target) return false;
    openTask(target.id, target.projectId ?? null);
    close();
    return true;
  };

  const runCommand = (id: PaletteCommandId, agent?: AgentKind, instanceId?: string) => {
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
    if (id === "check-updates") {
      close();
      void recheckUpdates();
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
    if (id === "prev-session") {
      switchVisibleSession(-1);
      return;
    }
    if (id === "next-session") {
      switchVisibleSession(1);
      return;
    }
    if (id === "toggle-sidebar") {
      toggleSidebar();
      close();
      return;
    }
    if (id === "toggle-theme") {
      toggleTheme();
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
      void tasksApi
        .forkTask(task.id, agent, instanceId)
        .then((entry) => openTask(entry.id, entry.projectId ?? null), showError);
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
    if (row.kind === "message" && row.sessionId) {
      const trimmed = query.trim();
      openTask(row.sessionId, row.projectId || null, {
        eventId: row.eventId,
        query: trimmed || undefined,
      });
      close();
      return;
    }
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
    if (row.commandId) runCommand(row.commandId, row.agent, row.instanceId);
  };

  const actions = useRef({
    input,
    runCommand,
    close,
    switchVisibleSession,
    open,
    drill,
    fileSearchOpen,
    settingsOpen,
    boardOpen,
    projects,
    tasks,
    task,
    project,
    panel,
    nextAttention,
    resolvedKeybindings,
  });
  actions.current = {
    input,
    runCommand,
    close,
    switchVisibleSession,
    open,
    drill,
    fileSearchOpen,
    settingsOpen,
    boardOpen,
    projects,
    tasks,
    task,
    project,
    panel,
    nextAttention,
    resolvedKeybindings,
  };

  useEffect(() => {
    const openMenu = () => {
      setOpen(true);
      setDrill("commands");
      setQuery("");
      setActive(0);
    };
    const onKey = (event: KeyboardEvent) => {
      if (typeof document !== "undefined" && document.querySelector("[data-keybinding-recording='true']")) {
        return;
      }
      const current = actions.current;
      const context = buildWhenContext({
        commandMenuOpen: current.open,
        modalOpen: current.fileSearchOpen ? true : undefined,
        panelOpen: Boolean(current.panel && current.panel.layout !== "chat"),
        settingsOpen: current.settingsOpen,
        boardOpen: current.boardOpen,
        sessionActive: Boolean(current.task && !current.settingsOpen && !current.boardOpen),
        projectActive: Boolean(current.project && !current.settingsOpen && !current.boardOpen),
        target: event.target,
      });

      const matched = resolveGlobalCommand(event, context, current.resolvedKeybindings);
      if (!matched) return;

      const cmd = matched.command;
      // `chat.find` 和 `browser.annotate` 由各自宿主结合局部作用域/标签页状态响应。
      if (cmd === "chat.find" || cmd === "browser.annotate") return;

      const visible = (id: PaletteCommandId) =>
        buildPaletteRows({ ...current.input, mode: "commands", query: "" }).some((row) => row.commandId === id);

      if (cmd === "commandMenu.toggle") {
        event.preventDefault();
        event.stopPropagation();
        setOpen((value) => !value);
        setDrill("commands");
        setQuery("");
        setActive(0);
        setFileNotice(null);
        return;
      }
      if (cmd === "quickOpen.toggle") {
        event.preventDefault();
        event.stopPropagation();
        if (current.open && current.drill === "files") {
          current.close();
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
      if (cmd === "sidebar.toggle") {
        event.preventDefault();
        event.stopPropagation();
        toggleSidebar();
        return;
      }
      if (cmd === "terminal.toggle" && visible("toggle-terminal")) {
        event.preventDefault();
        event.stopPropagation();
        current.runCommand("toggle-terminal");
        return;
      }
      if (cmd === "sideChat.toggle" && visible("toggle-side-chat")) {
        event.preventDefault();
        event.stopPropagation();
        current.runCommand("toggle-side-chat");
        return;
      }
      if (cmd === "session.new") {
        event.preventDefault();
        event.stopPropagation();
        if (visible("new-thread")) current.runCommand("new-thread");
        else current.runCommand("new-standalone");
        return;
      }
      if (cmd === "session.newStandalone") {
        event.preventDefault();
        event.stopPropagation();
        current.runCommand("new-standalone");
        return;
      }
      if (cmd === "project.openFolder") {
        event.preventDefault();
        event.stopPropagation();
        current.runCommand("open-folder");
        return;
      }
      if (cmd === "session.delete" && visible("delete")) {
        event.preventDefault();
        event.stopPropagation();
        const menu = deleteShortcutMenu(current.open);
        setOpen(menu.open);
        setDrill(menu.drill);
        current.runCommand("delete");
        return;
      }
      if (cmd === "files.search" && visible("search-files")) {
        event.preventDefault();
        event.stopPropagation();
        current.runCommand("search-files");
        return;
      }
      if (cmd === "panel.toggleFiles" && visible("toggle-files")) {
        event.preventDefault();
        event.stopPropagation();
        current.runCommand("toggle-files");
        return;
      }
      if (cmd === "panel.toggleChanges" && visible("toggle-changes")) {
        event.preventDefault();
        event.stopPropagation();
        current.runCommand("toggle-changes");
        return;
      }
      if (cmd === "board.toggle") {
        event.preventDefault();
        event.stopPropagation();
        if (current.boardOpen) closeBoard();
        else openBoard();
        current.close();
        return;
      }
      if (cmd === "settings.open") {
        event.preventDefault();
        event.stopPropagation();
        current.runCommand("settings");
        return;
      }
      if (cmd === "theme.toggle") {
        event.preventDefault();
        event.stopPropagation();
        current.runCommand("toggle-theme");
        return;
      }
      if (cmd === "session.nextAttention" && current.nextAttention) {
        event.preventDefault();
        event.stopPropagation();
        current.runCommand("next-attention");
        return;
      }
      if (cmd === "session.prev") {
        if (current.switchVisibleSession(-1)) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      if (cmd === "session.next") {
        if (current.switchVisibleSession(1)) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      const jumpIndex = parseSessionJumpIndex(cmd);
      if (jumpIndex !== null) {
        if (typeof document !== "undefined" && document.querySelector("[data-sidebar-search-results]")) {
          return;
        }
        const visibleTasks = computeVisibleSidebarTasks(
          current.projects,
          current.tasks,
          getSidebarViewState(),
        );
        const target = visibleTasks[jumpIndex - 1];
        event.preventDefault();
        event.stopPropagation();
        if (target) {
          openTask(target.id, target.projectId ?? null);
          current.close();
        }
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
          emptyText={
            filesOpen
              ? fileEmpty
              : taskSearch.loading && rows.length === 0
                ? COPY.searchPending
                : undefined
          }
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
