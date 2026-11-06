import type { BrowserHistory } from "../browser/browser.ts";
import {
  CLOSED_FILES_RAIL,
  layoutAfterHide,
  layoutAfterOpen,
  type PanelLayoutMode,
} from "../core/layout.ts";
import type { PanelTab, ViewerContext } from "../core/registry.ts";

export interface SessionPanel {
  tabs: PanelTab[];
  activeId: string;
  recentTabIds?: string[];
  histories: Record<string, BrowserHistory>;
  /** chat 收起侧栏但保留标签；split 并排；full 内容铺满、聊天让开。 */
  layout: PanelLayoutMode;
  filesExpanded: boolean;
  filesBeforePreview: boolean | null;
  filesTouched: boolean;
  filesSidebarOpen: boolean;
}

export function blankSession(): SessionPanel {
  return { tabs: [], activeId: "", histories: {}, layout: "chat", ...CLOSED_FILES_RAIL };
}

export function errorText(error: unknown): string {
  if (typeof error === "string" && error.trim()) return error;
  if (error instanceof Error && error.message.trim()) return error.message;
  return "无法读取文件";
}

export function placeTab(
  session: SessionPanel,
  tab: PanelTab,
  moveToEnd: boolean,
  activate: boolean,
  replaceTabId?: string,
): SessionPanel {
  const index = session.tabs.findIndex((item) => item.id === tab.id);
  let tabs: PanelTab[];
  const replacing = replaceTabId !== tab.id && session.tabs.some((item) => item.id === replaceTabId);
  if (replacing) {
    tabs = session.tabs.flatMap((item) => {
      if (item.id === replaceTabId) return [tab];
      return item.id === tab.id ? [] : [item];
    });
  } else if (index < 0 || moveToEnd) {
    tabs = [...session.tabs.filter((item) => item.id !== tab.id), tab];
  } else {
    tabs = session.tabs.slice();
    tabs[index] = tab;
  }
  const layout = activate ? layoutAfterOpen(session.layout) : session.layout;
  let histories = session.histories;
  if (replacing && replaceTabId && replaceTabId in histories) {
    histories = { ...histories };
    delete histories[replaceTabId];
  }
  const next = { ...session, tabs, histories, layout };
  return activate ? selectTab(next, tab.id) : next;
}

export function selectTab(session: SessionPanel, id: string): SessionPanel {
  return { ...session, activeId: id, recentTabIds: [id, ...(session.recentTabIds ?? []).filter((key) => key !== id && session.tabs.some((tab) => tab.id === key))] };
}

/** 已有标签再次打开：只聚焦并展开侧栏，不换掉 payload。 */
export function focusTab(session: SessionPanel, id: string, replaceTabId?: string): SessionPanel | null {
  const tab = session.tabs.find((item) => item.id === id);
  if (tab && replaceTabId && replaceTabId !== id) return placeTab(session, tab, false, true, replaceTabId);
  const layout = layoutAfterOpen(session.layout);
  if (session.activeId === id && session.layout === layout) return null;
  return selectTab({ ...session, layout }, id);
}

export function patchPayload(current: unknown, patch: Record<string, unknown>): unknown | null {
  const base: Record<string, unknown> =
    current && typeof current === "object" ? { ...(current as Record<string, unknown>) } : {};
  let changed = false;
  for (const [key, value] of Object.entries(patch)) {
    if (base[key] !== value) {
      base[key] = value;
      changed = true;
    }
  }
  return changed ? base : null;
}

export function dropTab(session: SessionPanel, id: string): SessionPanel {
  if (!session.tabs.some((tab) => tab.id === id) && !(id in session.histories)) return session;
  const tabs = session.tabs.filter((tab) => tab.id !== id);
  const activeId = session.activeId === id ? (tabs[tabs.length - 1]?.id ?? "") : session.activeId;
  const layout = tabs.length === 0 ? layoutAfterHide() : session.layout;
  if (!(id in session.histories)) return { ...session, tabs, activeId, layout };
  const histories = { ...session.histories };
  delete histories[id];
  return { ...session, tabs, activeId, histories, layout };
}

export function readTitle(payload: unknown): string {
  if (!payload || typeof payload !== "object" || !("title" in payload)) return "";
  const title = (payload as { title?: unknown }).title;
  return typeof title === "string" ? title : "";
}

export function emptyCtx(): ViewerContext {
  return { projectId: "", projectPath: "", sessionFiles: [] };
}
