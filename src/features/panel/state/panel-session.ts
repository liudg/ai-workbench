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
): SessionPanel {
  const index = session.tabs.findIndex((item) => item.id === tab.id);
  let tabs: PanelTab[];
  if (index < 0 || moveToEnd) {
    tabs = [...session.tabs.filter((item) => item.id !== tab.id), tab];
  } else {
    tabs = session.tabs.slice();
    tabs[index] = tab;
  }
  const layout = activate ? layoutAfterOpen(session.layout) : session.layout;
  return { ...session, tabs, activeId: activate ? tab.id : session.activeId, layout };
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
