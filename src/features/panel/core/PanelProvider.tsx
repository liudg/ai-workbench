import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  type ReactNode,
} from "react";

import type { SessionUsageView } from "@/store/session-usage";
import type { AgentKind, ChangeCapabilities, SessionEvent } from "@/types";
import { useCloseBrowserOnUnmount } from "../browser/use-browser-host";
import { showsFileChanges } from "@/features/changes-model/capabilities";
import type { PanelLayoutMode } from "./layout";
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
  openFiles: () => void;
  projectPath: string;
  sessionTitle: string;
  usage: SessionUsageView | null;
  layout: PanelLayoutMode;
  hidePanel: () => void;
  showPanel: () => void;
  toggleFull: () => void;
  setTabTitle: (id: string, title: string) => void;
  previewWidth: number | null;
  diffFilesWidth: number | null;
  setPreviewWidth: (width: number) => void;
  setDiffFilesWidth: (width: number) => void;
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
  sessionTitle,
  agent,
  events,
  usage,
  children,
}: {
  sessionId: string;
  projectId: string;
  projectPath: string;
  sessionTitle: string;
  agent: AgentKind | null;
  events: readonly SessionEvent[];
  usage: SessionUsageView | null;
  children: ReactNode;
}) {
  const tabs = useWorkbench((s) => s.panelBySession[sessionId]?.tabs ?? EMPTY_TABS);
  const activeId = useWorkbench((s) => s.panelBySession[sessionId]?.activeId ?? "");
  const layout = useWorkbench((s) => s.panelBySession[sessionId]?.layout ?? "chat");
  const previewWidth = useWorkbench((s) => s.previewWidthBySession[sessionId] ?? null);
  const diffFilesWidth = useWorkbench((s) => s.diffFilesWidthBySession[sessionId] ?? null);
  const changes = useWorkbench((s) => (agent ? s.profiles[agent]?.capabilities.changes : undefined));
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
  const openFiles = useCallback(() => {
    useWorkbench.getState().panelOpenFiles(sessionId);
  }, [sessionId]);
  const hidePanel = useCallback(() => {
    useWorkbench.getState().panelHide(sessionId);
  }, [sessionId]);
  const showPanel = useCallback(() => {
    useWorkbench.getState().panelShow(sessionId);
  }, [sessionId]);
  const toggleFull = useCallback(() => {
    useWorkbench.getState().panelToggleFull(sessionId);
  }, [sessionId]);
  const setTabTitle = useCallback(
    (id: string, title: string) => useWorkbench.getState().panelSetTitle(sessionId, id, title),
    [sessionId],
  );
  const setPreviewWidth = useCallback((width: number) => {
    useWorkbench.getState().panelSetPreviewWidth(sessionId, width);
  }, [sessionId]);
  const setDiffFilesWidth = useCallback((width: number) => {
    useWorkbench.getState().panelSetDiffFilesWidth(sessionId, width);
  }, [sessionId]);
  useCloseBrowserOnUnmount();

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
      openFiles,
      projectPath,
      sessionTitle,
      usage,
      layout,
      hidePanel,
      showPanel,
      toggleFull,
      setTabTitle,
      previewWidth,
      diffFilesWidth,
      setPreviewWidth,
      setDiffFilesWidth,
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
      openFiles,
      projectPath,
      sessionTitle,
      usage,
      layout,
      hidePanel,
      showPanel,
      toggleFull,
      setTabTitle,
      previewWidth,
      diffFilesWidth,
      setPreviewWidth,
      setDiffFilesWidth,
    ],
  );

  return <PreviewContext.Provider value={api}>{children}</PreviewContext.Provider>;
}
