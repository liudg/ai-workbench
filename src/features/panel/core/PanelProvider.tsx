import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  type ReactNode,
} from "react";

import type { BrowserFile } from "@/lib/native/open-path";
import type { SessionUsageView } from "@/store/session-usage";
import type {
  AgentKind,
  Attachment,
  ChangeCapabilities,
  DiffScope,
  FileSearchResult,
  PageAnnotation,
  PathFilter,
  PreviewDocument,
  PreviewImage,
  SessionEvent,
  SessionStatus,
  SubscriptionUsage,
  TreeEntry,
} from "@/types";
import type { TextSnippet, TextSnippetDraft } from "@/shared/text-snippet";
import type { BrowserHistory } from "../browser/browser";
import { useCloseBrowserOnUnmount } from "../browser/use-browser-host";
import { sessionChanges, showsFileChanges, type FileChange } from "@/features/changes-model";
import type { PanelLayoutMode } from "./layout";
import {
  browserDiffMenuStorage,
  readDiffMenuOptions,
} from "../diff/diff-menu-options";
import { defaultDiffViewPrefs, type DiffViewPrefs } from "../diff/view-prefs";
import type { PanelSlice } from "../state/slice";
import { queueTerminalRun } from "../terminal/terminal-runs";
import { emptyCtx } from "../state/panel-session";
import type { OpenTarget, PanelTab } from "./registry";

const EMPTY_TABS: PanelTab[] = [];
const EMPTY_HISTORIES: Record<string, BrowserHistory> = {};

/**
 * 面板要从外面拿的数据和动作：差异、文件、搜索、用系统程序打开、内置浏览器加载本地文件、
 * 页面批注发给 Agent、把文件放进作曲栏附件。路径都相对会话的工作目录。
 */
export interface PanelData {
  diffScopes(sessionId: string): Promise<DiffScope[]>;
  diffForScope(sessionId: string, scope: string, ignoreWhitespace: boolean): Promise<string>;
  readPreviewFile(projectId: string, path: string, sessionId: string): Promise<PreviewDocument>;
  readPreviewImage(projectId: string, path: string, sessionId: string): Promise<PreviewImage>;
  listDir(projectId: string, dir: string, sessionId: string): Promise<TreeEntry[]>;
  filterPaths(projectId: string, query: string, sessionId: string): Promise<PathFilter>;
  searchFiles(
    projectId: string,
    query: string,
    mask: string,
    searchId: number,
    sessionId: string,
  ): Promise<FileSearchResult>;
  openFile(projectId: string, path: string, mode: "default" | "choose", sessionId: string): Promise<void>;
  prepareBrowserFile(projectId: string, path: string, sessionId: string): Promise<BrowserFile>;
  submitAnnotation(sessionId: string, note: PageAnnotation): Promise<void>;
  attachFile(sessionId: string, file: Attachment): void;
  /** 预览里选中的文字放进作曲栏，发送时作为引用。 */
  addTextSnippet(sessionId: string, draft: TextSnippetDraft): void;
  /** 作曲栏里还没发出的文本片。评论在文件里留着显示，直到发出或移除。 */
  textSnippets: {
    subscribe(listener: () => void): () => void;
    read(sessionId: string): readonly TextSnippet[];
  };
  removeTextSnippet(sessionId: string, id: string): void;
  isGit(projectId: string, sessionId: string): Promise<boolean>;
  /** 在面板的工作目录里开一个终端，返回终端 id。 */
  openTerminal(cols: number, rows: number): Promise<string>;
  subscriptionUsage(agent: AgentKind): Promise<SubscriptionUsage>;
}

/** 面板的界面状态（标签、布局、宽度）放在哪个 store 里。 */
export interface PanelStateSource {
  use<T>(select: (state: PanelSlice) => T): T;
  get(): PanelSlice;
}

interface PanelApi {
  data: PanelData;
  histories: Record<string, BrowserHistory>;
  rememberHistory: (tabId: string, history: BrowserHistory) => void;
  status: SessionStatus | undefined;
  subscriptionSupported: boolean;
  tabs: PanelTab[];
  activeId: string;
  recentTabIds?: string[];
  projectId: string;
  sessionId: string;
  sessionFiles: FileChange[];
  changes: ChangeCapabilities | undefined;
  selectTab: (id: string) => void;
  closeTab: (id: string) => void;
  openDiff: (id: string, title: string, files: FileChange[], focusPath?: string) => void;
  openHref: (href: string, line?: number) => void;
  openBlank: () => void;
  openFiles: (replaceTabId?: string) => void;
  openTerminal: (replaceTabId?: string) => void;
  /** 打开终端并执行命令。终端还没开好时先排着。 */
  runInTerminal: (command: string) => void;
  /** 新建一个侧边聊天。这个会话开不了时为 null。 */
  openSideChat: ((replaceTabId?: string) => void) | null;
  openSubagents: ((replaceTabId?: string) => void) | null;
  projectPath: string;
  sessionTitle: string;
  agent: AgentKind | null;
  usage: SessionUsageView | null;
  layout: PanelLayoutMode;
  hidePanel: () => void;
  showPanel: () => void;
  toggleFull: () => void;
  setTabTitle: (id: string, title: string) => void;
  patchTabPayload: (tabId: string, patch: Record<string, unknown>) => void;
  previewWidth: number | null;
  diffFilesWidth: number | null;
  filesTreeWidth: number | null;
  diffView: DiffViewPrefs;
  setPreviewWidth: (width: number) => void;
  setDiffFilesWidth: (width: number) => void;
  setFilesTreeWidth: (width: number) => void;
  patchDiffView: (patch: Partial<DiffViewPrefs>) => void;
  filesTreeOpen: boolean;
  toggleFilesTree: () => void;
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

interface PanelProps {
  sessionId: string;
  projectId: string;
  projectPath: string;
  sessionTitle: string;
  agent: AgentKind | null;
  events: readonly SessionEvent[];
  usage: SessionUsageView | null;
  /** 侧边聊天标签的打开目标。宿主判断这个会话能不能开，开不了时不给。 */
  sideChat?: (() => OpenTarget) | null;
  /** 子智能体面板的打开目标。没有建好的会话时不给。 */
  subagents?: OpenTarget | null;
  children: ReactNode;
}

export function PanelHost({
  state,
  data,
  changes,
  status,
  subscriptionSupported,
  sessionId,
  projectId,
  projectPath,
  sessionTitle,
  agent,
  events,
  usage,
  sideChat = null,
  subagents = null,
  children,
}: PanelProps & {
  state: PanelStateSource;
  data: PanelData;
  changes: ChangeCapabilities | undefined;
  status: SessionStatus | undefined;
  subscriptionSupported: boolean;
}) {
  useCloseBrowserOnUnmount();
  const tabs = state.use((s) => s.panelBySession[sessionId]?.tabs ?? EMPTY_TABS);
  const activeId = state.use((s) => s.panelBySession[sessionId]?.activeId ?? "");
  const recentTabIds = state.use((s) => s.panelBySession[sessionId]?.recentTabIds);
  const layout = state.use((s) => s.panelBySession[sessionId]?.layout ?? "chat");
  const previewWidth = state.use((s) => s.previewWidthBySession[sessionId] ?? null);
  const diffFilesWidth = state.use((s) => s.diffFilesWidthBySession[sessionId] ?? null);
  const filesTreeWidth = state.use((s) => s.filesTreeWidthBySession[sessionId] ?? null);
  const storedDiffView = state.use((s) => s.diffViewBySession[sessionId]);
  const diffView = useMemo(
    () => storedDiffView ?? defaultDiffViewPrefs(readDiffMenuOptions(browserDiffMenuStorage())),
    [storedDiffView],
  );
  const sessionFiles = useMemo(
    () => (showsFileChanges(changes) ? sessionChanges(events) : []),
    [changes, events],
  );
  const filesRef = useRef(sessionFiles);
  filesRef.current = sessionFiles;
  const projectRef = useRef({ projectId, projectPath });
  const dataRef = useRef(data);
  dataRef.current = data;
  projectRef.current = { projectId, projectPath };

  const selectTab = useCallback(
    (id: string) => state.get().panelSelectTab(sessionId, id),
    [sessionId, state],
  );
  const closeTab = useCallback(
    (id: string) => state.get().panelCloseTab(sessionId, id),
    [sessionId, state],
  );
  const openDiff = useCallback(
    (id: string, title: string, files: FileChange[], focusPath?: string) => {
      state.get().panelOpenDiff(sessionId, id, title, files, focusPath);
    },
    [sessionId, state],
  );
  const openHref = useCallback(
    (href: string, line?: number) => {
      const project = projectRef.current;
      void state.get().panelOpenHref(sessionId, href, line, {
        projectId: project.projectId,
        projectPath: project.projectPath,
        sessionFiles: filesRef.current,
        sessionId,
        data: dataRef.current,
      });
    },
    [sessionId, state],
  );
  const openBlank = useCallback(() => {
    state.get().panelOpenBlank(sessionId);
  }, [sessionId, state]);
  const openFiles = useCallback((replaceTabId?: string) => {
    state.get().panelOpenFiles(sessionId, replaceTabId);
  }, [sessionId, state]);
  const openTerminal = useCallback((replaceTabId?: string) => {
    state.get().panelOpenTerminal(sessionId, replaceTabId);
  }, [sessionId, state]);
  const runInTerminal = useCallback(
    (command: string) => {
      queueTerminalRun(sessionId, command);
      state.get().panelOpenTerminal(sessionId);
    },
    [sessionId, state],
  );
  const openSideChat = useMemo(
    () => (sideChat ? (replaceTabId?: string) => void state.get().panelOpenTarget(sessionId, sideChat(), emptyCtx(), replaceTabId) : null),
    [sessionId, sideChat, state],
  );
  const openSubagents = useMemo(
    () => (subagents ? (replaceTabId?: string) => void state.get().panelOpenTarget(sessionId, subagents, emptyCtx(), replaceTabId) : null),
    [sessionId, subagents, state],
  );
  const hidePanel = useCallback(() => {
    state.get().panelHide(sessionId);
  }, [sessionId, state]);
  const showPanel = useCallback(() => {
    state.get().panelShow(sessionId);
  }, [sessionId, state]);
  const toggleFull = useCallback(() => {
    state.get().panelToggleFull(sessionId);
  }, [sessionId, state]);
  const setTabTitle = useCallback(
    (id: string, title: string) => state.get().panelSetTitle(sessionId, id, title),
    [sessionId, state],
  );
  const patchTabPayload = useCallback(
    (tabId: string, patch: Record<string, unknown>) =>
      state.get().panelPatchTabPayload(sessionId, tabId, patch),
    [sessionId, state],
  );
  const setPreviewWidth = useCallback((width: number) => {
    state.get().panelSetPreviewWidth(sessionId, width);
  }, [sessionId, state]);
  const setDiffFilesWidth = useCallback((width: number) => {
    state.get().panelSetDiffFilesWidth(sessionId, width);
  }, [sessionId, state]);
  const setFilesTreeWidth = useCallback((width: number) => {
    state.get().panelSetFilesTreeWidth(sessionId, width);
  }, [sessionId, state]);
  const patchDiffView = useCallback((patch: Partial<DiffViewPrefs>) => {
    state.get().panelPatchDiffView(sessionId, patch);
  }, [sessionId, state]);
  const histories = state.use((s) => s.panelBySession[sessionId]?.histories ?? EMPTY_HISTORIES);
  const rememberHistory = useCallback(
    (tabId: string, history: BrowserHistory) => state.get().panelRememberHistory(sessionId, tabId, history),
    [sessionId, state],
  );
  const filesTreeOpen = state.use((s) => s.panelBySession[sessionId]?.filesSidebarOpen ?? true);
  const toggleFilesTree = useCallback(() => {
    state.get().panelToggleFilesSidebar(sessionId);
  }, [sessionId, state]);
  const api = useMemo<PanelApi>(
    () => ({
      data,
      histories,
      rememberHistory,
      status,
      subscriptionSupported,
      tabs,
      activeId,
      recentTabIds,
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
      openTerminal,
      runInTerminal,
      openSideChat,
      openSubagents,
      projectPath,
      sessionTitle,
      agent,
      usage,
      layout,
      hidePanel,
      showPanel,
      toggleFull,
      setTabTitle,
      patchTabPayload,
      previewWidth,
      diffFilesWidth,
      filesTreeWidth,
      diffView,
      setPreviewWidth,
      setDiffFilesWidth,
      setFilesTreeWidth,
      patchDiffView,
      filesTreeOpen,
      toggleFilesTree,
    }),
    [
      data,
      histories,
      rememberHistory,
      status,
      subscriptionSupported,
      tabs,
      activeId,
      recentTabIds,
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
      openTerminal,
      runInTerminal,
      openSideChat,
      openSubagents,
      projectPath,
      sessionTitle,
      agent,
      usage,
      layout,
      hidePanel,
      showPanel,
      toggleFull,
      setTabTitle,
      patchTabPayload,
      previewWidth,
      diffFilesWidth,
      filesTreeWidth,
      diffView,
      setPreviewWidth,
      setDiffFilesWidth,
      setFilesTreeWidth,
      patchDiffView,
      filesTreeOpen,
      toggleFilesTree,
    ],
  );

  return <PreviewContext.Provider value={api}>{children}</PreviewContext.Provider>;
}

/** 面板里的组件用面板的数据来源。 */
export function usePanelData(): PanelData {
  return usePanel().data;
}
