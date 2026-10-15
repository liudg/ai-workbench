import { baseName } from "../../../shared/path.ts";
import {
  errorPayload,
  initialPayload,
  lineOf,
  mergeLoadedPayload,
  tabIdFor,
  withLine,
} from "../core/open-target.ts";
import { sameFile } from "../core/preview-kind.ts";
import {
  BinaryFileError,
  ReopenAs,
  resolveViewer,
  type OpenTarget,
  type ViewerContext,
} from "../core/registry.ts";
import { dropTab, errorText, placeTab, type SessionPanel } from "./panel-session.ts";

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
): Promise<void> {
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

    const existing = host.read(sessionId).tabs.find((tab) => tab.id === id);
    if (
      existing &&
      existing.status === "ready" &&
      existing.viewerId === viewer.id &&
      target.kind === "file"
    ) {
      const line = target.line;
      host.mutate(sessionId, (session) => {
        const tab = session.tabs.find((item) => item.id === id);
        if (!tab) return session.activeId === id ? null : { ...session, activeId: id };
        if (lineOf(tab.payload) === line && session.activeId === id) return null;
        if (lineOf(tab.payload) === line) return { ...session, activeId: id };
        return placeTab(session, { ...tab, payload: withLine(tab.payload, line) }, false, true);
      });
      return;
    }
    if (existing && target.kind === "url" && existing.status !== "error") {
      host.mutate(sessionId, (session) => (session.activeId === id ? null : { ...session, activeId: id }));
      return;
    }

    const payload = initialPayload(target);
    const blocked = target.kind === "blocked";
    const willLoad = Boolean(viewer.load) && (target.kind === "file" || target.kind === "custom");
    const status = blocked ? "error" : willLoad ? "loading" : "ready";
    const moveToEnd = target.kind === "diff";
    host.mutate(sessionId, (session) =>
      placeTab(session, { id, viewerId: viewer.id, payload, status }, moveToEnd, true),
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
      if (target.kind === "file" && !(error instanceof BinaryFileError)) {
        const match = ctx.sessionFiles.find((file) => sameFile(ctx.projectPath, file.path, target.path));
        if (match) {
          host.invalidate(sessionId, id);
          host.mutate(sessionId, (session) => dropTab(session, id));
          await openPanelTarget(host, 
            sessionId,
            { kind: "diff", id: `diff-file:${match.path}`, title: baseName(match.path), files: [match] },
            ctx,
            depth + 1,
          );
          return;
        }
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

