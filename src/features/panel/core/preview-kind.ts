import { normalizePath } from "../files/path.ts";

export type PreviewKind = "html" | "markdown" | "text";

export function previewKindForPath(path: string): PreviewKind {
  const name = path.split(/[\\/]/).pop() ?? path;
  const ext = name.includes(".") ? name.split(".").pop()?.toLowerCase() ?? "" : "";
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "md" || ext === "markdown" || ext === "mdx") return "markdown";
  return "text";
}

export function isFileHref(href: string): boolean {
  const raw = href.trim();
  if (!raw || /^(https?:|mailto:|data:|javascript:|#)/i.test(raw)) return false;
  if (/^file:/i.test(raw)) return true;
  if (/^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith("\\\\") || raw.startsWith("/")) return true;
  if (raw.startsWith("./") || raw.startsWith("../") || raw.includes("/") || raw.includes("\\")) {
    return true;
  }
  const name = raw.split(/[?#]/)[0] ?? raw;
  return /\.[A-Za-z0-9]{1,8}$/.test(name);
}

/**
 * 把文件链接解析成绝对路径。相对路径相对当前项目目录。
 * 项目外的绝对路径同样返回：树和搜索能打开的文件都应该能预览。
 * 外链和空路径返回 null。没有项目目录时，相对路径也返回 null。
 */
export function resolvePreviewPath(projectPath: string, href: string): string | null {
  const spec = hrefToPath(href);
  if (!spec) return null;
  if (isAbsolutePath(spec)) return normalizePath(spec);
  const root = projectPath.trim();
  if (!root) return null;
  return normalizePath(joinPath(root, spec));
}

export function sameFile(projectPath: string, changePath: string, absolute: string): boolean {
  const root = normalizePath(projectPath).replace(/\/$/, "").toLowerCase();
  const abs = normalizePath(absolute).toLowerCase();
  const change = normalizePath(changePath).replace(/^\.\//, "").toLowerCase();
  if (!change) return false;
  if (abs === change) return true;
  if (root && abs === `${root}/${change}`.replace(/\/{2,}/g, "/")) return true;
  return change.length > 0 && (abs === change || abs.endsWith(`/${change}`));
}

/** `annotate.html (line 12)` → 路径和行号。行号从 1 开始。 */
export function fileLineRef(label: string): { path: string; line: number } | null {
  const match = /^(.*\S)\s+\(line\s+(\d+)\)\s*$/i.exec(label.trim());
  if (!match) return null;
  const line = Number(match[2]);
  if (!Number.isInteger(line) || line < 1) return null;
  const path = match[1].trim();
  if (!path) return null;
  return { path, line };
}

export function lineFromHref(href: string): number | null {
  const hash = href.split("#")[1]?.split("&")[0] ?? "";
  const match = /^L(\d+)$/i.exec(hash);
  if (!match) return null;
  const line = Number(match[1]);
  return Number.isInteger(line) && line >= 1 ? line : null;
}

export function isHtmlHref(href: string): boolean {
  const bare = href.trim().split(/[?#]/)[0] ?? "";
  return /\.html?$/i.test(bare);
}

function hrefToPath(href: string): string | null {
  const trimmed = href.trim().replace(/^<|>$/g, "");
  if (!trimmed || /^(https?:|mailto:|data:|javascript:|#)/i.test(trimmed)) return null;
  const filePath = fileUrlPath(trimmed);
  const raw = filePath ?? trimmed;
  const cut = raw.split(/[?#]/)[0] ?? raw;
  try {
    return decodeURIComponent(cut);
  } catch {
    return cut;
  }
}

function fileUrlPath(href: string): string | null {
  if (!/^file:/i.test(href)) return null;
  try {
    const url = new URL(href);
    let path = decodeURIComponent(url.pathname);
    if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
    return path;
  } catch {
    return null;
  }
}

function isAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\") || path.startsWith("/");
}

function joinPath(root: string, rel: string): string {
  const slash = root.includes("\\") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${slash}${rel.replace(/^[\\/]+/, "")}`;
}
