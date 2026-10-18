import { useEffect, useMemo, useRef, useState } from "react";

import { FileSearchDialog } from "@/features/panel/files/FileSearchDialog";
import { sessionChanges } from "@/features/changes-model/diff-parse";
import { loadWorktreeDeletePreview } from "@/lib/worktree-delete-preview";
import {
  worktreeDeleteFlags,
  worktreeDeleteIsDirty,
  type WorktreeDeletePreview,
} from "@/lib/worktree-delete";
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
import { isArchiveChord, isDeleteChord, isNewThreadChord, isOpenChord } from "./keyboard";

export const OPEN_COMMAND_MENU = "ai-workbench:open-command-menu";

export function CommandMenuHost() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [drill, setDrill] = useState<PaletteDrill>("commands");
  const [active, setActive] = useState(0);
  const [renameTitle, setRenameTitle] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deletePreview, setDeletePreview] = useState<WorktreeDeletePreview | null | undefined>(undefined);
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
  const rows = buildPaletteRows(input);
  const safeActive = rows.length === 0 ? 0 : Math.min(active, rows.length - 1);

  const close = () => {
    setOpen(false);
    setQuery("");
    setDrill("commands");
    setActive(0);
    setRenameError(null);
    setDeleteError(null);
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
      setDeletePreview(undefined);
      setDrill("delete");
      void loadWorktreeDeletePreview(session.id).then(setDeletePreview);
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
    if (row.commandId) runCommand(row.commandId);
  };

  const actions = useRef({ input, runCommand });
  actions.current = { input, runCommand };

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

  const confirmDelete = (action: "delete" | "keep-worktree" | "discard-worktree") => {
    if (!session || !project || deletePreview === undefined) return;
    const flags = worktreeDeleteFlags(action, deletePreview);
    void useWorkbench.getState().deleteSession(project.id, session.id, flags).then((ok) => {
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
          dirtyWorktree={worktreeDeleteIsDirty(deletePreview ?? null)}
          deleteReady={deletePreview !== undefined}
          onQuery={(value) => {
            setQuery(value);
            setActive(0);
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
          }}
          onRenameTitle={setRenameTitle}
          onRenameSubmit={submitRename}
          onDeleteConfirm={() => confirmDelete("delete")}
          onKeepWorktree={() => confirmDelete("keep-worktree")}
          onDiscardWorktree={() => confirmDelete("discard-worktree")}
        />
      ) : null}
      {fileSearchProjectId ? (
        <FileSearchDialog
          projectId={fileSearchProjectId}
          sessionId={activeSessionId[fileSearchProjectId]}
          onClose={() => setFileSearchProjectId(null)}
          onOpen={(path, line) => {
            const current = useWorkbench.getState();
            const target = current.projects.find((item) => item.id === fileSearchProjectId);
            const openSession = target ? current.activeSessionId[target.id] : null;
            const openWorkdir = openSession
              ? current.sessions[target?.id ?? ""]?.find((item) => item.id === openSession)?.workdir?.trim()
              : "";
            if (!target || !openSession) return;
            void current.panelOpenHref(openSession, path, line ?? undefined, {
              projectId: target.id,
              projectPath: openWorkdir || target.path,
              sessionFiles: [],
              sessionId: openSession,
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
