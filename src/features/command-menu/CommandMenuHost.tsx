import { useEffect, useMemo, useRef, useState } from "react";

import { FileSearchDialog } from "@/features/panel/files/FileSearchDialog";
import { sessionChanges } from "@/features/changes-model/diff-parse";
import { toggleSidebar } from "@/features/sidebar/visibility";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { useWorkbench } from "@/store";
import { STANDALONE_DRAFT_ID } from "@/store/standalone";
import type { AgentCatalog, AgentKind, AgentProfile } from "@/types";

import {
  buildPaletteRows,
  resolveCommandAgent,
  type PaletteCaps,
  type PaletteCommandId,
  type PaletteSession,
} from "./commands";
import { CommandMenu, type PaletteDrill } from "./CommandMenu";
import { COMMAND_MENU_COPY as COPY } from "./copy";
import { fileRows } from "./file-rows";
import {
  isArchiveChord,
  isDeleteChord,
  isNewThreadChord,
  isOpenChord,
  isQuickOpenChord,
  isSidebarChord,
} from "./keyboard";
import { useQuickOpen } from "./useQuickOpen";

export const OPEN_COMMAND_MENU = "ai-workbench:open-command-menu";

export function CommandMenuHost() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [drill, setDrill] = useState<PaletteDrill>("commands");
  const [active, setActive] = useState(0);
  const [renameTitle, setRenameTitle] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [fileNotice, setFileNotice] = useState<string | null>(null);
  const [fileSearchProjectId, setFileSearchProjectId] = useState<string | null>(null);

  const projects = useWorkbench((s) => s.projects);
  const sessions = useWorkbench((s) => s.sessions);
  const selectedProjectId = useWorkbench((s) => s.selectedProjectId);
  const activeSessionId = useWorkbench((s) => s.activeSessionId);
  const pinnedSessionIds = useWorkbench((s) => s.pinnedSessionIds);
  const installations = useWorkbench((s) => s.installations);
  const preferredAgent = useWorkbench((s) => s.preferredAgent);
  const catalogs = useWorkbench((s) => s.catalogs);
  const profiles = useWorkbench((s) => s.profiles);

  const project = projects.find((item) => item.id === selectedProjectId) ?? null;
  const sessionId = project ? (activeSessionId[project.id] ?? null) : null;
  const sessionList = project ? (sessions[project.id] ?? []) : [];
  const session = sessionId ? (sessionList.find((item) => item.id === sessionId) ?? null) : null;

  const paletteSessions = useMemo<PaletteSession[]>(() => {
    const rows: PaletteSession[] = [];
    for (const [projectId, list] of Object.entries(sessions)) {
      for (const item of list) {
        rows.push({
          id: item.id,
          projectId,
          title: item.title,
          archived: item.archived === true,
          updatedAt: item.updated_at,
          pinned: pinnedSessionIds.includes(item.id),
        });
      }
    }
    return rows;
  }, [pinnedSessionIds, sessions]);

  const caps = sessionCaps(session?.id ?? null, session?.agent ?? null, catalogs, profiles);
  const agent = resolveCommandAgent({
    installations,
    activeAgent: session?.agent ?? null,
    projectDefault: project && !project.standalone ? project.default_agent : null,
    preferred: preferredAgent,
  });
  const input = {
    query,
    mode: drill === "chats" ? ("chats" as const) : ("commands" as const),
    sessions: paletteSessions,
    activeSessionId: session?.id ?? null,
    caps,
    canNewThread: Boolean(agent && project && !project.standalone),
    canStandalone: Boolean(agent),
    canSearchFiles: Boolean(session && project),
  };
  const filesOpen = open && drill === "files";
  const quick = useQuickOpen(project?.id ?? null, query, filesOpen);
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

  const runCommand = (id: PaletteCommandId) => {
    const state = useWorkbench.getState();
    if (id === "new-thread" && agent && project && !project.standalone) {
      state.openDraft(project.id, agent);
      close();
      return;
    }
    if (id === "new-standalone" && agent) {
      state.openDraft(STANDALONE_DRAFT_ID, agent);
      close();
      return;
    }
    if (id === "open-folder") {
      state.openDialog("import");
      close();
      return;
    }
    if (id === "settings") {
      state.openSettings();
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
    if (id === "search-files" && project && session) {
      setFileSearchProjectId(project.id);
      close();
      return;
    }
    if (!session || !project) return;
    if (id === "pin") {
      state.togglePinnedSession(session.id);
      close();
      return;
    }
    if (id === "archive") {
      void state.archiveSession(project.id, session.id, session.archived !== true);
      close();
      return;
    }
    if (id === "fork") {
      void state.forkSession(project.id, session.id);
      close();
      return;
    }
    if (id === "rename") {
      setRenameTitle(session.title);
      setRenameError(null);
      setDrill("rename");
      return;
    }
    if (id === "delete") {
      setDeleteError(null);
      setDrill("delete");
      return;
    }
    if (id === "toggle-files") {
      const panel = state.panelBySession[session.id];
      const activeTab = panel?.tabs.find((tab) => tab.id === panel.activeId);
      const showing = Boolean(panel && panel.layout !== "chat" && activeTab?.viewerId === "files");
      if (showing) state.panelHide(session.id);
      else state.panelOpenFiles(session.id);
      close();
      return;
    }
    if (id === "toggle-changes") {
      const panel = state.panelBySession[session.id];
      const activeTab = panel?.tabs.find((tab) => tab.id === panel.activeId);
      const showing = Boolean(panel && panel.layout !== "chat" && activeTab?.viewerId === "diff");
      if (showing) state.panelHide(session.id);
      else {
        state.panelOpenDiff(
          session.id,
          `diff:${session.id}`,
          DESKTOP_ZH.changesTab,
          sessionChanges(state.events[session.id] ?? []),
        );
      }
      close();
    }
  };

  const runIndex = (index: number) => {
    const row = rows[index];
    if (!row) return;
    if (row.kind === "chat" && row.sessionId && row.projectId) {
      void useWorkbench.getState().selectSession(row.projectId, row.sessionId);
      close();
      return;
    }
    if (row.kind === "file" && row.filePath) {
      if (!project || !session) {
        setFileNotice(COPY.needSession);
        return;
      }
      void useWorkbench.getState().panelOpenHref(session.id, row.filePath, undefined, {
        projectId: project.id,
        projectPath: project.path,
        sessionFiles: [],
      });
      close();
      return;
    }
    if (row.commandId) runCommand(row.commandId);
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
      if (isNewThreadChord(event) && visible("new-thread")) {
        event.preventDefault();
        event.stopPropagation();
        current.runCommand("new-thread");
        return;
      }
      if (isArchiveChord(event) && visible("archive")) {
        event.preventDefault();
        event.stopPropagation();
        current.runCommand("archive");
        return;
      }
      if (isDeleteChord(event) && visible("delete")) {
        event.preventDefault();
        event.stopPropagation();
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
    if (!session || !renameTitle.trim()) return;
    void useWorkbench.getState().renameSession(session.id, renameTitle).then((ok) => {
      if (ok) close();
      else setRenameError(COPY.renameError);
    });
  };

  const confirmDelete = () => {
    if (!session || !project) return;
    void useWorkbench.getState().deleteSession(project.id, session.id).then((ok) => {
      if (ok) close();
      else setDeleteError(COPY.deleteError);
    });
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
          onDeleteConfirm={confirmDelete}
        />
      ) : null}
      {fileSearchProjectId ? (
        <FileSearchDialog
          projectId={fileSearchProjectId}
          onClose={() => setFileSearchProjectId(null)}
          onOpen={(path, line) => {
            const current = useWorkbench.getState();
            const target = current.projects.find((item) => item.id === fileSearchProjectId);
            const openSession = target ? current.activeSessionId[target.id] : null;
            if (!target || !openSession) return;
            void current.panelOpenHref(openSession, path, line ?? undefined, {
              projectId: target.id,
              projectPath: target.path,
              sessionFiles: [],
            });
          }}
        />
      ) : null}
    </>
  );
}

function sessionCaps(
  sessionId: string | null,
  agent: AgentKind | null,
  catalogs: Record<string, AgentCatalog>,
  profiles: Partial<Record<AgentKind, AgentProfile>>,
): PaletteCaps | null {
  if (!sessionId || !agent) return null;
  const catalog = catalogs[sessionId]?.capabilities;
  if (catalog) return catalog;
  const profile = profiles[agent];
  if (profile?.kind === agent) return profile.capabilities;
  return null;
}
