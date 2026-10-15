/**
 * 工作区三列和差异文件栏的宽度。
 * 预览打开时先收起会话文件栏，关闭全部标签后再还原。
 */

export const SIDEBAR_WIDTH = 260;
export const CHAT_MIN_WIDTH = 540;
export const CHAT_MAX_WIDTH = 760;
export const PANEL_PREFERRED_WIDTH = 540;
/** 拖分隔条时预览可以收到这个宽度，这样默认布局下也能往右拖。 */
export const PREVIEW_MIN_WIDTH = 400;
export const FILES_EXPANDED_WIDTH = 240;
export const FILES_RAIL_WIDTH = 44;
export const DIFF_LIST_WIDTH = 208;
export const DIFF_LIST_MIN = 176;
export const DIFF_BODY_MIN = 220;

export interface FilesRailState {
  filesExpanded: boolean;
  /** 预览打开前的展开状态。null 表示预览没有接管。 */
  filesBeforePreview: boolean | null;
  filesTouched: boolean;
  /** 关掉后文件列消失，预览标签还在。 */
  filesSidebarOpen: boolean;
}

export const CLOSED_FILES_RAIL: FilesRailState = {
  filesExpanded: false,
  filesBeforePreview: null,
  filesTouched: false,
  filesSidebarOpen: true,
};

export type PanelLayoutMode = "chat" | "split" | "full";

export interface WorkspaceColumns {
  chat: number;
  panel: number;
  files: number;
}

/** 打开内容时从纯聊天回到分屏；完整视图保持铺满。 */
export function layoutAfterOpen(mode: PanelLayoutMode): PanelLayoutMode {
  return mode === "chat" ? "split" : mode;
}

export function layoutAfterHide(): PanelLayoutMode {
  return "chat";
}

/** 收起后点标记：有标签就回到分屏。完整视图不从这里进入。 */
export function layoutAfterShow(mode: PanelLayoutMode): PanelLayoutMode {
  return mode === "full" ? "full" : "split";
}

export function layoutAfterFullToggle(mode: PanelLayoutMode): PanelLayoutMode {
  if (mode === "chat") return "full";
  return mode === "full" ? "split" : "full";
}

export function filesColumnWidth(expanded: boolean, visible: boolean): number {
  if (!visible) return 0;
  return expanded ? FILES_EXPANDED_WIDTH : FILES_RAIL_WIDTH;
}

/**
 * 分屏时聊天列落在 540–760，右侧预览优先 540。
 * 更宽时多出来的给预览；放不下时先缩小预览，再让聊天低于下限。
 */
export function workspaceColumns(input: {
  rowWidth: number;
  panelOpen: boolean;
  filesExpanded: boolean;
  filesVisible: boolean;
  panelMode?: PanelLayoutMode;
}): WorkspaceColumns {
  const files = filesColumnWidth(input.filesExpanded, input.filesVisible);
  const mode = input.panelMode ?? (input.panelOpen ? "split" : "chat");
  if (input.rowWidth <= 0) return { chat: 0, panel: 0, files };
  const room = Math.max(0, input.rowWidth - files);
  if (mode === "chat") return { chat: room, panel: 0, files };
  if (mode === "full") return { chat: 0, panel: room, files };
  const chatFloor = Math.min(CHAT_MIN_WIDTH, room);
  let panel = Math.min(PANEL_PREFERRED_WIDTH, Math.max(0, room - chatFloor));
  let chat = room - panel;
  if (chat > CHAT_MAX_WIDTH) {
    chat = CHAT_MAX_WIDTH;
    panel = room - chat;
  }
  return { chat, panel, files };
}

/** 面板放得下文件栏时给它固定宽度；放不下就整栏收起，避免被压成一个字。 */
export function diffListWidth(paneWidth: number): number | null {
  if (paneWidth < DIFF_LIST_MIN + DIFF_BODY_MIN) return null;
  const room = paneWidth - DIFF_BODY_MIN;
  return Math.min(DIFF_LIST_WIDTH, Math.max(DIFF_LIST_MIN, room));
}

export function settleFilesRail(state: FilesRailState, previewOpen: boolean): FilesRailState {
  if (previewOpen) {
    if (state.filesBeforePreview !== null) return state;
    return {
      ...state,
      filesBeforePreview: state.filesExpanded,
      filesExpanded: false,
    };
  }
  if (state.filesBeforePreview === null) return state;
  return {
    ...state,
    filesExpanded: state.filesBeforePreview,
    filesBeforePreview: null,
  };
}

export function withPreviewRail<T extends FilesRailState>(session: T, previewOpen: boolean): T {
  const settled = settleFilesRail(session, previewOpen);
  if (settled === session) return session;
  return { ...session, ...settled };
}

export function toggleFilesRail(state: FilesRailState): FilesRailState {
  return { ...state, filesExpanded: !state.filesExpanded, filesTouched: true };
}

export function toggleFilesSidebar(state: FilesRailState): FilesRailState {
  return { ...state, filesSidebarOpen: !state.filesSidebarOpen };
}

/**
 * 拖聊天和预览之间的分隔条。
 * 默认布局仍把聊天留在 540–760，多出来的给预览。
 * 拖的时候预览可以继续收到 PREVIEW_MIN_WIDTH，聊天因此可以宽过 760，
 * 否则宽屏上预览已经贴着下限，分隔条只能往左。
 * 行宽不够时预览下限让路，避免把聊天挤没。
 */
export function panelWidthAfterDrag(rowWidth: number, filesWidth: number, requested: number): number {
  const room = Math.max(0, rowWidth - filesWidth);
  const chatFloor = Math.min(CHAT_MIN_WIDTH, room);
  const maxPanel = Math.max(0, room - chatFloor);
  const previewFloor = Math.min(PREVIEW_MIN_WIDTH, maxPanel);
  return Math.max(previewFloor, Math.min(Math.round(requested), maxPanel));
}

/** 文件列宽度由拖拽决定。minWidth 设成 0，内容的最小宽度才不会挡住往右收。 */
export function pinnedColumnStyle(width: number): {
  width: number;
  maxWidth: number;
  minWidth: number;
  flexBasis: number;
  flexGrow: number;
  flexShrink: number;
} {
  const next = Math.max(0, Math.round(width));
  return {
    width: next,
    maxWidth: next,
    minWidth: 0,
    flexBasis: next,
    flexGrow: 0,
    flexShrink: 0,
  };
}

/** 拖差异和文件列表之间的分隔条。放不下就收起文件列表。 */
export function diffListWidthAfterDrag(paneWidth: number, requested: number): number | null {
  if (paneWidth < DIFF_LIST_MIN + DIFF_BODY_MIN) return null;
  const max = paneWidth - DIFF_BODY_MIN;
  return Math.max(DIFF_LIST_MIN, Math.min(Math.round(requested), max));
}

/** 有文件且用户没手动收起过时展开。预览开着时只记住还原值，不把栏重新撑开。 */
export function noteFilesRail(state: FilesRailState, hasFiles: boolean): FilesRailState | null {
  if (!hasFiles || state.filesTouched || state.filesExpanded) return null;
  if (state.filesBeforePreview !== null) {
    if (state.filesBeforePreview) return null;
    return { ...state, filesBeforePreview: true };
  }
  return { ...state, filesExpanded: true };
}
