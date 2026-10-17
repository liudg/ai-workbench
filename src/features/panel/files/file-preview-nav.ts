/** 文件导航和预览内容之间的连接。目录只展开，文件才进入预览。 */

import { baseName, workspaceRootLabel } from "../../../shared/path.ts";

/** 面包屑最左一截。有盘符用盘符，否则用项目目录名。 */
export function previewRootLabel(projectPath: string): string {
  return workspaceRootLabel(projectPath) || baseName(projectPath);
}

export type FileOpenMode = "workspace" | "file";
export type TreeSurface = "sidebar" | "dropdown";

export interface PreviewSelection {
  path: string;
  isPreview: true;
}

export interface BreadcrumbSegment {
  label: string;
  path: string;
  last: boolean;
}

export interface DropdownTreeQuery {
  openMode: FileOpenMode;
  directoryPath: string;
  expandedPaths: string[];
  includeHidden: true;
  surface: "dropdown";
  revealSelectedPath: true;
  shouldExpandActivePath: boolean;
  workspaceRoot: string;
}

export type PreviewShellStatus = "empty" | "loading" | "error" | "tooLarge" | "unsupported" | "ready";

const UNSUPPORTED_EXT = new Set([
  "zip",
  "tar",
  "gz",
  "tgz",
  "bz2",
  "7z",
  "rar",
  "mp3",
  "wav",
  "ogg",
  "flac",
  "aac",
  "m4a",
  "mp4",
  "mov",
  "avi",
  "mkv",
  "webm",
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "exe",
  "dll",
  "bin",
  "dmg",
  "iso",
]);

/** 路径以分隔符结尾，或条目标成目录，都不打开文件。 */
export function isDirectorySelection(path: string, kind?: string): boolean {
  if (kind === "dir") return true;
  const trimmed = path.trim();
  return trimmed.endsWith("/") || trimmed.endsWith("\\");
}

/** 文件项返回预览意图。目录项返回 null，调用方只做展开。 */
export function previewSelection(path: string, kind?: string): PreviewSelection | null {
  const trimmed = path.trim();
  if (!trimmed || isDirectorySelection(trimmed, kind)) return null;
  return { path: trimmed.replace(/[\\/]+$/, ""), isPreview: true };
}

/** 项目根在最前。项目外的绝对路径不再套一层盘符。 */
export function previewCrumbs(path: string, rootLabel: string): BreadcrumbSegment[] {
  const file = breadcrumbSegments(path);
  const label = rootLabel.trim();
  const outside = /^[A-Za-z]:/.test(path) || path.startsWith("/");
  if (!label || outside) return file;
  return [{ label, path: "", last: false }, ...file];
}

export function breadcrumbSegments(path: string): BreadcrumbSegment[] {
  const normalized = path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!normalized) return [];
  const parts = normalized.split("/").filter(Boolean);
  const segments: BreadcrumbSegment[] = [];
  let walked = "";
  parts.forEach((part, index) => {
    walked = walked ? `${walked}/${part}` : part;
    segments.push({ label: part, path: walked, last: index === parts.length - 1 });
  });
  return segments;
}

/** 末段是文件名，其余段是目录。 */
export function openModeForSegment(last: boolean): FileOpenMode {
  return last ? "file" : "workspace";
}

export function shouldExpandActivePath(openMode: FileOpenMode): boolean {
  return openMode === "workspace";
}

export function parentDirectory(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index > 0 ? normalized.slice(0, index) : "";
}

/** 文件段列出所在目录。目录段列出该目录本身。 */
export function dropdownDirectoryPath(activePath: string, segmentPath: string, openMode: FileOpenMode): string {
  if (openMode === "file") return parentDirectory(activePath);
  return segmentPath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

/**
 * 工作区模式沿当前文件把目录展开到文件上一层。
 * 文件模式不预展开，下拉只停在同目录列表。
 */
export function expandedPathsForOpen(openMode: FileOpenMode, activePath: string, directoryPath: string): string[] {
  if (openMode !== "workspace") return [];
  const active = activePath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const root = directoryPath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!active) return [];
  const dirs = active.split("/").filter(Boolean).slice(0, -1);
  const paths: string[] = [];
  let walked = "";
  for (const part of dirs) {
    walked = walked ? `${walked}/${part}` : part;
    if (root && (walked === root || !walked.startsWith(`${root}/`))) continue;
    paths.push(walked);
  }
  return paths;
}

export function dropdownTreeQuery(input: {
  activePath: string;
  segmentPath: string;
  last: boolean;
  workspaceRoot: string;
}): DropdownTreeQuery {
  const openMode = openModeForSegment(input.last);
  const directoryPath = dropdownDirectoryPath(input.activePath, input.segmentPath, openMode);
  return {
    openMode,
    directoryPath,
    expandedPaths: expandedPathsForOpen(openMode, input.activePath, directoryPath),
    includeHidden: true,
    surface: "dropdown",
    revealSelectedPath: true,
    shouldExpandActivePath: shouldExpandActivePath(openMode),
    workspaceRoot: input.workspaceRoot,
  };
}

export function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  return name.slice(dot + 1).toLowerCase();
}

export function isUnsupportedPreviewPath(path: string): boolean {
  return UNSUPPORTED_EXT.has(extensionOf(path));
}

export function previewShellStatus(input: {
  path: string;
  phase: "idle" | "loading" | "error" | "ready";
  kind?: string;
  truncated?: boolean;
}): PreviewShellStatus {
  if (!input.path.trim()) return "empty";
  if (isUnsupportedPreviewPath(input.path)) return "unsupported";
  if (input.phase === "idle" || input.phase === "loading") return "loading";
  if (input.phase === "error") return "error";
  if (input.kind === "binary") return "unsupported";
  if (input.truncated) return "tooLarge";
  return "ready";
}
