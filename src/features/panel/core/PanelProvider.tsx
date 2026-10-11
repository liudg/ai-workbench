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
import type { SessionEvent } from "@/types";
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
  selectTab: (id: string) => void;
  closeTab: (id: string) => void;
  openDiff: (id: string, title: string, files: FileChange[]) => void;
  openHref: (href: string, line?: number) => void;
  openBlank: () => void;
  setTabTitle: (id: string, title: string) => void;
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
  events,
  children,
}: {
  sessionId: string;
  projectId: string;
  projectPath: string;
  events: readonly SessionEvent[];
  children: ReactNode;
}) {
  const tabs = useWorkbench((s) => s.panelBySession[sessionId]?.tabs ?? EMPTY_TABS);
  const activeId = useWorkbench((s) => s.panelBySession[sessionId]?.activeId ?? "");
  const sessionFiles = useMemo(() => sessionChanges(events), [events]);
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
      selectTab,
      closeTab,
      openDiff,
      openHref,
      openBlank,
      setTabTitle,
    }),
    [
      tabs,
      activeId,
      projectId,
      sessionId,
      sessionFiles,
      selectTab,
      closeTab,
      openDiff,
      openHref,
      openBlank,
      setTabTitle,
    ],
  );

  return <PreviewContext.Provider value={api}>{children}</PreviewContext.Provider>;
}
