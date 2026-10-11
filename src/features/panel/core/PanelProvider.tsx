import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";

import { backend } from "@/lib/ipc";
import type { AgentKind, ChangeCapabilities, SessionEvent } from "@/types";
import { showsFileChanges } from "@/features/changes-model/capabilities";
import { sessionChanges, type FileChange } from "@/features/changes-model/diff-parse";
import { useWorkbench } from "@/store";
import type { PanelTab } from "./registry";

const EMPTY_TABS: PanelTab[] = [];

interface PanelApi {
  tabs: PanelTab[];
  activeId: string;
  projectId: string;
  sessionId: string;
  sessionFiles: FileChange[];
  changes: ChangeCapabilities | undefined;
  selectTab: (id: string) => void;
  closeTab: (id: string) => void;
  openDiff: (id: string, title: string, files: FileChange[]) => void;
  openHref: (href: string, line?: number) => void;
  openBlank: () => void;
  setTabTitle: (id: string, title: string) => void;
  filesExpanded: boolean;
  toggleFiles: () => void;
}

const PreviewContext = createContext<PanelApi | null>(null);

export function usePanel(): PanelApi {
  const value = useContext(PreviewContext);
  if (!value) throw new Error("预览尚未就绪");
  return value;
}

export function usePanelOptional(): PanelApi | null {
  return useContext(PreviewContext);
}

export type { PanelTab };

export function PanelProvider({
  sessionId,
  projectId,
  projectPath,
  agent,
  events,
  children,
}: {
  sessionId: string;
  projectId: string;
  projectPath: string;
  agent: AgentKind;
  events: readonly SessionEvent[];
  children: ReactNode;
}) {
  const tabs = useWorkbench((s) => s.panelBySession[sessionId]?.tabs ?? EMPTY_TABS);
  const activeId = useWorkbench((s) => s.panelBySession[sessionId]?.activeId ?? "");
  const hasRail = useWorkbench((s) => s.panelBySession[sessionId] !== undefined);
  const storedExpanded = useWorkbench((s) => s.panelBySession[sessionId]?.filesExpanded ?? false);
  const changes = useWorkbench((s) => s.profiles[agent]?.capabilities.changes);
  const sessionFiles = useMemo(
    () => (showsFileChanges(changes) ? sessionChanges(events) : []),
    [changes, events],
  );
  const filesRef = useRef(sessionFiles);
  filesRef.current = sessionFiles;
  const projectRef = useRef({ projectId, projectPath });
  projectRef.current = { projectId, projectPath };

  const selectTab = useCallback(
    (id: string) => useWorkbench.getState().panelSelectTab(sessionId, id),
    [sessionId],
  );
  const closeTab = useCallback(
    (id: string) => useWorkbench.getState().panelCloseTab(sessionId, id),
    [sessionId],
  );
  const openDiff = useCallback(
    (id: string, title: string, files: FileChange[]) => {
      useWorkbench.getState().panelOpenDiff(sessionId, id, title, files);
    },
    [sessionId],
  );
  const openHref = useCallback(
    (href: string, line?: number) => {
      const project = projectRef.current;
      void useWorkbench.getState().panelOpenHref(sessionId, href, line, {
        projectId: project.projectId,
        projectPath: project.projectPath,
        sessionFiles: filesRef.current,
      });
    },
    [sessionId],
  );
  const openBlank = useCallback(() => {
    useWorkbench.getState().panelOpenBlank(sessionId);
  }, [sessionId]);
  const setTabTitle = useCallback(
    (id: string, title: string) => useWorkbench.getState().panelSetTitle(sessionId, id, title),
    [sessionId],
  );
  const toggleFiles = useCallback(() => {
    useWorkbench.getState().panelToggleFiles(sessionId);
  }, [sessionId]);
  const hasFiles = sessionFiles.length > 0;
  const filesExpanded = hasRail ? storedExpanded : hasFiles;
  useEffect(() => {
    useWorkbench.getState().panelNoteFiles(sessionId, hasFiles);
  }, [sessionId, hasFiles]);

  useEffect(() => {
    return () => {
      void backend.browserClose();
    };
  }, []);

  const api = useMemo<PanelApi>(
    () => ({
      tabs,
      activeId,
      projectId,
      sessionId,
      sessionFiles,
      changes,
      selectTab,
      closeTab,
      openDiff,
      openHref,
      openBlank,
      setTabTitle,
      filesExpanded,
      toggleFiles,
    }),
    [
      tabs,
      activeId,
      projectId,
      sessionId,
      sessionFiles,
      changes,
      selectTab,
      closeTab,
      openDiff,
      openHref,
      openBlank,
      setTabTitle,
      filesExpanded,
      toggleFiles,
    ],
  );

  return <PreviewContext.Provider value={api}>{children}</PreviewContext.Provider>;
}
