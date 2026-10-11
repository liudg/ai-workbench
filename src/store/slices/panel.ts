import type { FileChange } from "../../features/changes-model/diff-parse.ts";
import type { BrowserHistory } from "../../features/panel/browser/browser.ts";
import { baseName } from "../../features/panel/files/path.ts";
import {
  errorPayload,
  initialPayload,
  lineOf,
  mergeLoadedPayload,
  tabIdFor,
  targetFromHref,
  withLine,
} from "../../features/panel/core/open-target.ts";
import { sameFile } from "../../features/panel/core/preview-kind.ts";
import {
  BinaryFileError,
  ReopenAs,
  resolveViewer,
  type OpenTarget,
  type PanelTab,
  type ViewerContext,
} from "../../features/panel/core/registry.ts";

export interface SessionPanel {
  tabs: PanelTab[];
  activeId: string;
  histories: Record<string, BrowserHistory>;
}

export interface PanelSlice {
  panelBySession: Record<string, SessionPanel>;
  panelSelectTab(sessionId: string, id: string): void;
  panelCloseTab(sessionId: string, id: string): void;
  panelSetTitle(sessionId: string, id: string, title: string): void;
  panelOpenHref(sessionId: string, href: string, line: number | undefined, ctx: ViewerContext): Promise<void>;
  panelOpenDiff(sessionId: string, id: string, title: string, files: FileChange[]): void;
  panelOpenBlank(sessionId: string): void;
  panelOpenTarget(sessionId: string, target: OpenTarget, ctx: ViewerContext): Promise<void>;
  panelRememberHistory(sessionId: string, tabId: string, history: BrowserHistory): void;
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

function blankSession(): SessionPanel {
  return { tabs: [], activeId: "", histories: {} };
}

function errorText(error: unknown): string {
  if (typeof error === "string" && error.trim()) return error;
  if (error instanceof Error && error.message.trim()) return error.message;
  return "无法读取文件";
}

function placeTab(session: SessionPanel, tab: PanelTab, moveToEnd: boolean, activate: boolean): SessionPanel {
  const index = session.tabs.findIndex((item) => item.id === tab.id);
  let tabs: PanelTab[];
  if (index < 0 || moveToEnd) {
    tabs = [...session.tabs.filter((item) => item.id !== tab.id), tab];
  } else {
    tabs = session.tabs.slice();
    tabs[index] = tab;
  }
  return { ...session, tabs, activeId: activate ? tab.id : session.activeId };
}

export function createPanelSlice(set: PanelSet, get: PanelGet): PanelSlice {
  const mutate = (sessionId: string, recipe: (session: SessionPanel) => SessionPanel | null) => {
    set((state) => {
      const current = state.panelBySession[sessionId] ?? blankSession();
      const next = recipe(current);
      if (!next || next === current) return state;
      return { panelBySession: { ...state.panelBySession, [sessionId]: next } };
    });
  };

  const read = (sessionId: string) => get().panelBySession[sessionId] ?? blankSession();

  const invalidate = (sessionId: string, tabId: string) => {
    ticket += 1;
    loads.set(loadKey(sessionId, tabId), ticket);
  };

  async function open(sessionId: string, target: OpenTarget, ctx: ViewerContext, depth: number): Promise<void> {
    const id = tabIdFor(target);
    if (depth > 3) {
      mutate(sessionId, (session) => {
        const tab = session.tabs.find((item) => item.id === id);
        if (!tab) return null;
        return placeTab(
          session,
          { ...tab, status: "error", payload: errorPayload(tab.payload, "无法读取文件") },
          false,
          false,
        );
      });
      return;
    }
    const viewer = resolveViewer(target);
    if (!viewer) {
      mutate(sessionId, (session) => {
        const tab = session.tabs.find((item) => item.id === id);
        if (!tab) return null;
        return placeTab(
          session,
          { ...tab, status: "error", payload: errorPayload(tab.payload, "无法读取文件") },
          false,
          false,
        );
      });
      return;
    }

    const existing = read(sessionId).tabs.find((tab) => tab.id === id);
    if (
      existing &&
      existing.status === "ready" &&
      existing.viewerId === viewer.id &&
      target.kind === "file"
    ) {
      const line = target.line;
      mutate(sessionId, (session) => {
        const tab = session.tabs.find((item) => item.id === id);
        if (!tab) return session.activeId === id ? null : { ...session, activeId: id };
        if (lineOf(tab.payload) === line && session.activeId === id) return null;
        if (lineOf(tab.payload) === line) return { ...session, activeId: id };
        return placeTab(session, { ...tab, payload: withLine(tab.payload, line) }, false, true);
      });
      return;
    }
    if (existing && target.kind === "url" && existing.status !== "error") {
      mutate(sessionId, (session) => (session.activeId === id ? null : { ...session, activeId: id }));
      return;
    }

    const payload = initialPayload(target);
    const blocked = target.kind === "blocked";
    const willLoad = Boolean(viewer.load) && (target.kind === "file" || target.kind === "custom");
    const status = blocked ? "error" : willLoad ? "loading" : "ready";
    const moveToEnd = target.kind === "diff";
    mutate(sessionId, (session) =>
      placeTab(session, { id, viewerId: viewer.id, payload, status }, moveToEnd, true),
    );
    if (!willLoad || !viewer.load) return;

    const mine = ticket + 1;
    ticket = mine;
    const key = loadKey(sessionId, id);
    loads.set(key, mine);
    try {
      const loaded = await viewer.load(target, ctx);
      if (loads.get(key) !== mine) return;
      mutate(sessionId, (session) => {
        const tab = session.tabs.find((item) => item.id === id);
        if (!tab) return null;
        return placeTab(
          session,
          {
            ...tab,
            viewerId: viewer.id,
            status: "ready",
            payload: mergeLoadedPayload(tab.payload, loaded),
          },
          false,
          false,
        );
      });
    } catch (error) {
      if (loads.get(key) !== mine) return;
      if (error instanceof ReopenAs) {
        await open(sessionId, error.target, ctx, depth + 1);
        return;
      }
      if (target.kind === "file" && !(error instanceof BinaryFileError)) {
        const match = ctx.sessionFiles.find((file) => sameFile(ctx.projectPath, file.path, target.path));
        if (match) {
          invalidate(sessionId, id);
          mutate(sessionId, (session) => dropTab(session, id));
          await open(
            sessionId,
            { kind: "diff", id: `diff-file:${match.path}`, title: baseName(match.path), files: [match] },
            ctx,
            depth + 1,
          );
          return;
        }
      }
      const message = errorText(error);
      mutate(sessionId, (session) => {
        const tab = session.tabs.find((item) => item.id === id);
        if (!tab) return null;
        return placeTab(
          session,
          { ...tab, status: "error", payload: errorPayload(tab.payload, message) },
          false,
          false,
        );
      });
    }
  }

  return {
    panelBySession: {},

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
      await open(sessionId, targetFromHref(ctx.projectPath, href, line), ctx, 0);
    },

    panelOpenDiff(sessionId, id, title, files) {
      void open(sessionId, { kind: "diff", id, title, files }, emptyCtx(), 0);
    },

    panelOpenBlank(sessionId) {
      void open(sessionId, { kind: "blank" }, emptyCtx(), 0);
    },

    async panelOpenTarget(sessionId, target, ctx) {
      await open(sessionId, target, ctx, 0);
    },

    panelRememberHistory(sessionId, tabId, history) {
      set((state) => {
        const session = state.panelBySession[sessionId] ?? blankSession();
        if (session.histories[tabId] === history) return state;
        return {
          panelBySession: {
            ...state.panelBySession,
            [sessionId]: {
              tabs: session.tabs,
              activeId: session.activeId,
              histories: { ...session.histories, [tabId]: history },
            },
          },
        };
      });
    },
  };
}

function dropTab(session: SessionPanel, id: string): SessionPanel {
  if (!session.tabs.some((tab) => tab.id === id) && !(id in session.histories)) return session;
  const tabs = session.tabs.filter((tab) => tab.id !== id);
  const activeId = session.activeId === id ? (tabs[tabs.length - 1]?.id ?? "") : session.activeId;
  if (!(id in session.histories)) return { ...session, tabs, activeId };
  const histories = { ...session.histories };
  delete histories[id];
  return { ...session, tabs, activeId, histories };
}

function readTitle(payload: unknown): string {
  if (!payload || typeof payload !== "object" || !("title" in payload)) return "";
  const title = (payload as { title?: unknown }).title;
  return typeof title === "string" ? title : "";
}

function emptyCtx(): ViewerContext {
  return { projectId: "", projectPath: "", sessionFiles: [] };
}
