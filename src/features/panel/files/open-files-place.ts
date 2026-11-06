/** 「打开文件」当前预览、已打开的文件和筛选。记在这个标签的 payload 上，切走、收起再打开还在。 */

import { normalizePath, relativeToProject } from "../../../shared/path.ts";
import { resolvePreviewPath } from "../core/preview-kind.ts";

export interface OpenFileTab {
  path: string;
  line: number | null;
  /** 只有临时预览带此标记；同一组文件最多保留一个。 */
  preview?: true;
}

export interface OpenFilesPlace {
  path: string;
  line: number | null;
  filter: string;
  tabs: OpenFileTab[];
}

const EMPTY: OpenFilesPlace = { path: "", line: null, filter: "", tabs: [] };

/** 同一个会话换了项目才清掉预览。切到别的会话时，那边自己的路径还在。 */
export function clearOpenFilesOnScope(
  previous: { projectId: string; sessionId: string },
  next: { projectId: string; sessionId: string },
): boolean {
  return previous.sessionId === next.sessionId && previous.projectId !== next.projectId;
}

/** 会话链接和目录树都收成相对项目的路径。项目外的文件保持绝对路径。 */
export function canonicalOpenPath(projectPath: string, path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return "";
  const resolved = resolvePreviewPath(projectPath, trimmed) ?? normalizePath(trimmed);
  if (!projectPath.trim()) return resolved;
  return relativeToProject(resolved, projectPath) || resolved;
}

export function sameOpenPath(left: string, right: string): boolean {
  return normalizePath(left).toLowerCase() === normalizePath(right).toLowerCase();
}

export function openFilesPlace(payload: unknown): OpenFilesPlace {
  if (!payload || typeof payload !== "object") return EMPTY;
  const record = payload as { path?: unknown; line?: unknown; filter?: unknown; tabs?: unknown };
  const path = typeof record.path === "string" ? record.path : "";
  const line = lineOf(record.line);
  const filter = typeof record.filter === "string" ? record.filter : "";
  return { path, line, filter, tabs: readTabs(record.tabs, path, line) };
}

/** 首个文件常驻；单击复用预览位，已常驻的文件不会退回预览。 */
export function openFileInPlace(
  place: OpenFilesPlace,
  path: string,
  line: number | null,
  isPreview = true,
): OpenFilesPlace {
  const nextPath = path.trim();
  if (!nextPath) return place;
  const tabs = place.tabs.slice();
  const index = tabs.findIndex((tab) => sameOpenPath(tab.path, nextPath));
  const preview = isPreview && (index >= 0 ? tabs[index].preview === true : tabs.length > 0);
  const next: OpenFileTab = { path: nextPath, line, ...(preview ? { preview: true } : {}) };
  const previewIndex = preview ? tabs.findIndex((tab) => tab.preview) : -1;
  if (index >= 0) tabs[index] = next;
  else if (previewIndex >= 0) tabs[previewIndex] = next;
  else tabs.push(next);
  if (place.path === nextPath && place.line === line && index >= 0 && tabs.length === place.tabs.length) {
    const previous = place.tabs[index];
    if (previous && previous.path === nextPath && previous.line === line && previous.preview === next.preview) return place;
  }
  return { ...place, path: nextPath, line, tabs };
}

export function keepOpenFile(place: OpenFilesPlace, path: string): OpenFilesPlace {
  const tab = place.tabs.find((item) => sameOpenPath(item.path, path));
  return tab ? openFileInPlace(place, tab.path, tab.line, false) : place;
}

export function selectOpenFile(place: OpenFilesPlace, path: string): OpenFilesPlace {
  const tab = place.tabs.find((item) => sameOpenPath(item.path, path));
  if (!tab) return place;
  if (place.path === tab.path && place.line === tab.line) return place;
  return { ...place, path: tab.path, line: tab.line };
}

/** 关掉当前文件后，相邻的那个接上。 */
export function closeOpenFile(place: OpenFilesPlace, path: string): OpenFilesPlace {
  const index = place.tabs.findIndex((tab) => sameOpenPath(tab.path, path));
  if (index < 0) return place;
  const tabs = place.tabs.filter((_, at) => at !== index);
  if (!sameOpenPath(place.path, path)) return { ...place, tabs };
  const next = tabs[index] ?? tabs[index - 1] ?? null;
  if (!next) return { ...place, path: "", line: null, tabs };
  return { ...place, path: next.path, line: next.line, tabs };
}

function lineOf(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
}

function readTabs(value: unknown, path: string, line: number | null): OpenFileTab[] {
  if (!Array.isArray(value)) return path ? [{ path, line }] : [];
  const tabs: OpenFileTab[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const tabPath = typeof (item as { path?: unknown }).path === "string" ? (item as { path: string }).path : "";
    if (!tabPath) continue;
    const preview = (item as { preview?: unknown }).preview === true;
    tabs.push({ path: tabPath, line: lineOf((item as { line?: unknown }).line), ...(preview ? { preview: true } : {}) });
  }
  if (path && !tabs.some((tab) => sameOpenPath(tab.path, path))) tabs.push({ path, line });
  return tabs;
}
