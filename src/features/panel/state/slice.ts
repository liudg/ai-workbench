import type { FileChange } from "../../changes-model/diff-parse.ts";
import {
  defaultDiffViewPrefs,
  diffViewPrefsEqual,
  mergeDiffViewPrefs,
  type DiffViewPrefs,
} from "../diff/view-prefs.ts";
import type { BrowserHistory } from "../browser/browser.ts";
import {
  layoutAfterFullToggle,
  layoutAfterHide,
  layoutAfterShow,
  noteFilesRail,
  toggleFilesRail,
  toggleFilesSidebar,
  withPreviewRail,
} from "../core/layout.ts";
import { targetFromHref } from "../core/open-target.ts";
import type { OpenTarget, ViewerContext } from "../core/registry.ts";
import { openPanelTarget } from "./panel-load.ts";
import {
  blankSession,
  dropTab,
  emptyCtx,
  placeTab,
  readTitle,
  type SessionPanel,
} from "./panel-session.ts";

export type { SessionPanel } from "./panel-session.ts";

export interface PanelSlice {
  panelBySession: Record<string, SessionPanel>;
  panelSelectTab(sessionId: string, id: string): void;
  panelCloseTab(sessionId: string, id: string): void;
  panelSetTitle(sessionId: string, id: string, title: string): void;
  panelOpenHref(sessionId: string, href: string, line: number | undefined, ctx: ViewerContext): Promise<void>;
  panelOpenDiff(sessionId: string, id: string, title: string, files: FileChange[]): void;
  panelOpenBlank(sessionId: string): void;
  /** 打开或聚焦「打开文件」标签。 */
  panelOpenFiles(sessionId: string): void;
  /** 收起侧栏。标签还在，标记改成打开的标签数。 */
  panelHide(sessionId: string): void;
  /** 没有标签时打开内置浏览器新标签页，否则只把侧栏展开。 */
  panelShow(sessionId: string): void;
  panelToggleFull(sessionId: string): void;
  panelOpenTarget(sessionId: string, target: OpenTarget, ctx: ViewerContext): Promise<void>;
  panelRememberHistory(sessionId: string, tabId: string, history: BrowserHistory): void;
  panelToggleFiles(sessionId: string): void;
  panelToggleFilesSidebar(sessionId: string): void;
  panelNoteFiles(sessionId: string, hasFiles: boolean): void;
  /** 聊天和预览之间拖出来的预览列宽度。不写入会话面板，避免把文件栏状态提前创建出来。 */
  previewWidthBySession: Record<string, number>;
  /** 差异正文和文件列之间拖出来的文件列宽度。 */
  diffFilesWidthBySession: Record<string, number>;
  /** 差异工具栏的并排、换行、展开和 ··· 勾选。按会话记，切标签不丢。 */
  diffViewBySession: Record<string, DiffViewPrefs>;
  panelSetPreviewWidth(sessionId: string, width: number): void;
  panelSetDiffFilesWidth(sessionId: string, width: number): void;
  panelPatchDiffView(sessionId: string, patch: Partial<DiffViewPrefs>): void;
}

type PanelSet = (
  partial: Partial<PanelSlice> | ((state: PanelSlice) => Partial<PanelSlice> | PanelSlice),
) => void;
type PanelGet = () => PanelSlice;

const loads = new Map<string, number>();
let ticket = 0;

function loadKey(sessionId: string, tabId: string) {
  return `${sessionId}\0${tabId}`;
}

export function createPanelSlice(set: PanelSet, get: PanelGet): PanelSlice {
  const mutate = (sessionId: string, recipe: (session: SessionPanel) => SessionPanel | null) => {
    set((state) => {
      const current = state.panelBySession[sessionId] ?? blankSession();
      const next = recipe(current);
      if (!next || next === current) return state;
      const synced = withPreviewRail(next, next.layout !== "chat" && next.tabs.length > 0);
      return { panelBySession: { ...state.panelBySession, [sessionId]: synced } };
    });
  };

  const read = (sessionId: string) => get().panelBySession[sessionId] ?? blankSession();

  const invalidate = (sessionId: string, tabId: string) => {
    ticket += 1;
    loads.set(loadKey(sessionId, tabId), ticket);
  };

  const rememberWidth = (
    key: "previewWidthBySession" | "diffFilesWidthBySession",
    sessionId: string,
    width: number,
  ) => {
    const next = Math.round(width);
    if (!Number.isFinite(next) || next < 0) return;
    set((state) => {
      if (state[key][sessionId] === next) return state;
      return { [key]: { ...state[key], [sessionId]: next } };
    });
  };

  const beginLoad = (sessionId: string, tabId: string) => {
    const mine = ticket + 1;
    ticket = mine;
    const key = loadKey(sessionId, tabId);
    loads.set(key, mine);
    return { mine, key };
  };
  const isCurrent = (key: string, mine: number) => loads.get(key) === mine;
  const host = { read, mutate, beginLoad, isCurrent, invalidate };

  return {
    panelBySession: {},
    previewWidthBySession: {},
    diffFilesWidthBySession: {},
    diffViewBySession: {},

    panelSelectTab(sessionId, id) {
      mutate(sessionId, (session) => (session.activeId === id ? null : { ...session, activeId: id }));
    },

    panelCloseTab(sessionId, id) {
      loads.delete(loadKey(sessionId, id));
      mutate(sessionId, (session) => dropTab(session, id));
    },

    panelSetTitle(sessionId, id, title) {
      const next = title.trim();
      if (!next) return;
      const session = read(sessionId);
      const tab = session.tabs.find((item) => item.id === id);
      if (!tab || readTitle(tab.payload) === next) return;
      mutate(sessionId, (current) => {
        const found = current.tabs.find((item) => item.id === id);
        if (!found || readTitle(found.payload) === next) return null;
        const payload =
          found.payload && typeof found.payload === "object"
            ? { ...(found.payload as object), title: next }
            : { title: next };
        return placeTab(current, { ...found, payload }, false, false);
      });
    },

    async panelOpenHref(sessionId, href, line, ctx) {
      await openPanelTarget(host, sessionId, targetFromHref(ctx.projectPath, href, line), ctx, 0);
    },

    panelOpenDiff(sessionId, id, title, files) {
      void openPanelTarget(host, sessionId, { kind: "diff", id, title, files }, emptyCtx(), 0);
    },

    panelOpenBlank(sessionId) {
      void openPanelTarget(host, sessionId, { kind: "blank" }, emptyCtx(), 0);
    },

    panelOpenFiles(sessionId) {
      void openPanelTarget(host, sessionId, { kind: "custom", type: "open-files" }, emptyCtx(), 0);
    },

    panelHide(sessionId) {
      mutate(sessionId, (session) =>
        session.layout === "chat" ? null : { ...session, layout: layoutAfterHide() },
      );
    },

    panelShow(sessionId) {
      const session = read(sessionId);
      if (session.tabs.length === 0) {
        void openPanelTarget(host, sessionId, { kind: "blank" }, emptyCtx(), 0);
        return;
      }
      mutate(sessionId, (current) => {
        const layout = layoutAfterShow(current.layout);
        return layout === current.layout ? null : { ...current, layout };
      });
    },

    panelToggleFull(sessionId) {
      const session = read(sessionId);
      if (session.tabs.length === 0) {
        void openPanelTarget(host, sessionId, { kind: "blank" }, emptyCtx(), 0);
        mutate(sessionId, (current) =>
          current.layout === "full" ? null : { ...current, layout: "full" },
        );
        return;
      }
      mutate(sessionId, (current) => ({ ...current, layout: layoutAfterFullToggle(current.layout) }));
    },

    async panelOpenTarget(sessionId, target, ctx) {
      await openPanelTarget(host, sessionId, target, ctx, 0);
    },

    panelRememberHistory(sessionId, tabId, history) {
      set((state) => {
        const session = state.panelBySession[sessionId] ?? blankSession();
        if (session.histories[tabId] === history) return state;
        return {
          panelBySession: {
            ...state.panelBySession,
            [sessionId]: { ...session, histories: { ...session.histories, [tabId]: history } },
          },
        };
      });
    },

    panelToggleFiles(sessionId) {
      mutate(sessionId, (session) => ({ ...session, ...toggleFilesRail(session) }));
    },

    panelToggleFilesSidebar(sessionId) {
      mutate(sessionId, (session) => ({ ...session, ...toggleFilesSidebar(session) }));
    },

    panelNoteFiles(sessionId, hasFiles) {
      mutate(sessionId, (session) => {
        const noted = noteFilesRail(session, hasFiles);
        return noted ? { ...session, ...noted } : null;
      });
    },

    panelSetPreviewWidth(sessionId, width) {
      rememberWidth("previewWidthBySession", sessionId, width);
    },

    panelSetDiffFilesWidth(sessionId, width) {
      rememberWidth("diffFilesWidthBySession", sessionId, width);
    },

    panelPatchDiffView(sessionId, patch) {
      if (!sessionId) return;
      set((state) => {
        const current = state.diffViewBySession[sessionId] ?? defaultDiffViewPrefs();
        const next = mergeDiffViewPrefs(current, patch);
        if (state.diffViewBySession[sessionId] && diffViewPrefsEqual(current, next)) return state;
        return { diffViewBySession: { ...state.diffViewBySession, [sessionId]: next } };
      });
    },
  };
}
