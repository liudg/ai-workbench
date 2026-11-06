import {
  errorPayload,
  initialPayload,
  mergeLoadedPayload,
  tabIdFor,
} from "../core/open-target.ts";
import { opensLocalHtmlInBrowser } from "../core/preview-kind.ts";
import { ReopenAs, resolveViewer, viewerById, type OpenTarget, type ViewerContext } from "../core/registry.ts";
import { sessionAfterSharedFileOpen } from "./open-shared-file.ts";
import { errorText, focusTab, placeTab, type SessionPanel } from "./panel-session.ts";

export interface PanelLoadHost {
  read(sessionId: string): SessionPanel;
  mutate(sessionId: string, recipe: (session: SessionPanel) => SessionPanel | null): void;
  beginLoad(sessionId: string, tabId: string): { mine: number; key: string };
  isCurrent(key: string, mine: number): boolean;
  invalidate(sessionId: string, tabId: string): void;
}

export async function openPanelTarget(
  host: PanelLoadHost,
  sessionId: string,
  target: OpenTarget,
  ctx: ViewerContext,
  depth: number,
  replaceTabId?: string,
): Promise<void> {
  const releaseReplacedTab = (targetId: string) => {
    if (!replaceTabId || replaceTabId === targetId) return;
    const replaced = host.read(sessionId).tabs.find((tab) => tab.id === replaceTabId);
    if (!replaced) return;
    host.invalidate(sessionId, replaceTabId);
    viewerById(replaced.viewerId)?.dispose?.(replaced.payload);
  };
  if (target.kind === "file" && !opensInAppBrowser(target)) {
    host.mutate(sessionId, (session) =>
      sessionAfterSharedFileOpen(session, ctx.projectPath, target.path, target.line),
    );
    return;
  }
    const id = tabIdFor(target);
    if (depth > 3) {
      host.mutate(sessionId, (session) => {
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
      host.mutate(sessionId, (session) => {
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

    releaseReplacedTab(id);
    const existing = host.read(sessionId).tabs.find((tab) => tab.id === id);
    if (existing && target.kind === "url" && existing.status !== "error") {
      host.mutate(sessionId, (session) => focusTab(session, id, replaceTabId));
      return;
    }
    if (
      existing &&
      target.kind === "custom" &&
      (!viewer.load || Boolean(replaceTabId)) &&
      existing.viewerId === viewer.id &&
      existing.status !== "error"
    ) {
      host.mutate(sessionId, (session) => focusTab(session, id, replaceTabId));
      return;
    }

    const payload = initialPayload(target);
    const blocked = target.kind === "blocked";
    // 本地 HTML 不进「打开文件」，要加载页面后交给内置浏览器。
    const willLoad = Boolean(viewer.load) && (target.kind === "custom" || target.kind === "file");
    const status = blocked ? "error" : willLoad ? "loading" : "ready";
    const moveToEnd = target.kind === "diff";
    host.mutate(sessionId, (session) =>
      placeTab(session, { id, viewerId: viewer.id, payload, status }, moveToEnd, true, replaceTabId),
    );
    if (!willLoad || !viewer.load) return;

    const loaded = host.beginLoad(sessionId, id);
    const mine = loaded.mine;
    const key = loaded.key;
    try {
      const loaded = await viewer.load(target, ctx);
      if (!host.isCurrent(key, mine)) return;
      host.mutate(sessionId, (session) => {
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
      if (!host.isCurrent(key, mine)) return;
      if (error instanceof ReopenAs) {
        await openPanelTarget(host, sessionId, error.target, ctx, depth + 1);
        return;
      }
      const message = errorText(error);
      host.mutate(sessionId, (session) => {
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

/** 无行号的本地 HTML 进内置浏览器。指定了别的查看器时仍进「打开文件」。 */
function opensInAppBrowser(target: Extract<OpenTarget, { kind: "file" }>): boolean {
  if (target.viewerId && target.viewerId !== "html") return false;
  return opensLocalHtmlInBrowser(target.path, target.line);
}

