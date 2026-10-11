/**
 * 工作区三列和差异文件栏的宽度。
 * 预览打开时先收起会话文件栏，关闭全部标签后再还原。
 */

export const CHAT_MIN_WIDTH = 400;
export const PANEL_PREFERRED_WIDTH = 560;
export const PANEL_MAX_RATIO = 0.44;
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
}

export const CLOSED_FILES_RAIL: FilesRailState = {
  filesExpanded: false,
  filesBeforePreview: null,
  filesTouched: false,
};

export interface WorkspaceColumns {
  chat: number;
  panel: number;
  files: number;
}

export function filesColumnWidth(expanded: boolean, visible: boolean): number {
  if (!visible) return 0;
  return expanded ? FILES_EXPANDED_WIDTH : FILES_RAIL_WIDTH;
}

/** 聊天列不低于下限；多出来的宽度优先给预览，但预览有上限，不够时预览缩小。 */
export function workspaceColumns(input: {
  rowWidth: number;
  panelOpen: boolean;
  filesExpanded: boolean;
  filesVisible: boolean;
}): WorkspaceColumns {
  const files = filesColumnWidth(input.filesExpanded, input.filesVisible);
  if (input.rowWidth <= 0) return { chat: 0, panel: 0, files };
  const room = Math.max(0, input.rowWidth - files);
  if (!input.panelOpen) return { chat: room, panel: 0, files };
  const preferred = Math.min(
    PANEL_PREFERRED_WIDTH,
    Math.round(input.rowWidth * PANEL_MAX_RATIO),
  );
  const chatFloor = Math.min(CHAT_MIN_WIDTH, room);
  const panel = Math.max(0, Math.min(preferred, room - chatFloor));
  return { chat: room - panel, panel, files };
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

/** 有文件且用户没手动收起过时展开。预览开着时只记住还原值，不把栏重新撑开。 */
export function noteFilesRail(state: FilesRailState, hasFiles: boolean): FilesRailState | null {
  if (!hasFiles || state.filesTouched || state.filesExpanded) return null;
  if (state.filesBeforePreview !== null) {
    if (state.filesBeforePreview) return null;
    return { ...state, filesBeforePreview: true };
  }
  return { ...state, filesExpanded: true };
}
