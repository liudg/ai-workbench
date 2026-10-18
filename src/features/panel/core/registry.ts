import type { ComponentType } from "react";

import type { FileChange } from "../../changes-model/diff-parse.ts";

/** 打开动作。查看器只靠 match 得分认领，核心不按种类分支渲染。 */
export type OpenTarget =
  | { kind: "blank" }
  | { kind: "url"; url: string }
  | { kind: "file"; path: string; line: number | null; viewerId?: string }
  | { kind: "blocked"; href: string; line: number | null; message: string }
  | { kind: "diff"; id: string; title: string; files: FileChange[] }
  | { kind: "custom"; type: string; data?: unknown };

export interface ViewerContext {
  projectId: string;
  projectPath: string;
  sessionFiles: FileChange[];
  /** 有工作树时，预览和搜索读这个会话的检出目录。 */
  sessionId?: string;
}

export type PanelTabStatus = "loading" | "ready" | "error";

export interface PanelTab<P = unknown> {
  id: string;
  viewerId: string;
  payload: P;
  status: PanelTabStatus;
}

export interface MenuItem {
  id: string;
  label: string;
  disabled?: boolean;
  onSelect?: () => void;
}

export interface ViewerViewProps<P = unknown> {
  tabId: string;
  payload: P;
  status: PanelTabStatus;
  sessionId: string;
  projectId: string;
  setTitle: (title: string) => void;
}

export interface PanelViewer<P = unknown> {
  id: string;
  match(target: OpenTarget): number;
  icon: ComponentType<{ className?: string }>;
  title(payload: P): string;
  load?(target: OpenTarget, ctx: ViewerContext): Promise<P>;
  View: ComponentType<ViewerViewProps<P>>;
  menu?: MenuItem[];
}

/** 服务端判定不能当文本打开。不要改走 diff。 */
export class BinaryFileError extends Error {
  constructor() {
    super("这个文件不能以文本预览。");
    this.name = "BinaryFileError";
  }
}

/** 加载时发现应由另一个查看器接手。核心只负责重开，不认识具体种类。 */
export class ReopenAs extends Error {
  readonly target: OpenTarget;
  constructor(target: OpenTarget) {
    super("reopen");
    this.name = "ReopenAs";
    this.target = target;
  }
}

const viewers: PanelViewer<any>[] = [];

export function registerViewer(viewer: PanelViewer<any>): () => void {
  const index = viewers.findIndex((item) => item.id === viewer.id);
  if (index >= 0) viewers[index] = viewer;
  else viewers.push(viewer);
  return () => {
    const at = viewers.indexOf(viewer);
    if (at >= 0) viewers.splice(at, 1);
  };
}

export function resolveViewer(target: OpenTarget): PanelViewer<any> | null {
  let best: PanelViewer<any> | null = null;
  let score = 0;
  for (const viewer of viewers) {
    const next = viewer.match(target);
    if (next > score) {
      score = next;
      best = viewer;
    }
  }
  return best;
}

export function viewerById(id: string): PanelViewer<any> | null {
  return viewers.find((viewer) => viewer.id === id) ?? null;
}

/** 显式指定 viewerId 时只让该查看器得分，其它返回 0。未指定则返回 null。 */
export function pinnedScore(target: OpenTarget, id: string): number | null {
  if (target.kind !== "file" || !target.viewerId) return null;
  return target.viewerId === id ? 100 : 0;
}

export function payloadTitle(payload: unknown): string {
  if (!payload || typeof payload !== "object" || !("title" in payload)) return "";
  const title = (payload as { title?: unknown }).title;
  return typeof title === "string" ? title.trim() : "";
}
