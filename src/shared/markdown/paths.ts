// 本机路径的识别和缩短。块解析和行内解析共用，不负责 Markdown 语法。

import type { Inline } from "./ast.ts";

export const CODE_EXT =
  "cs|ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|cpp|cc|cxx|c|h|hpp|hh|lua|json|xml|yml|yaml|toml|shader|hlsl|uxml|uss|asmdef|vue|rb|php|swift|mm|csproj|sln|html|css|scss";
export const CODE_FILE = new RegExp(`^[\\w.+@-]+\\.(?:${CODE_EXT})$`, "i");
export const CODE_FILE_IN = new RegExp(`[\\w.+@-]+\\.(?:${CODE_EXT})\\b`, "i");

export const TEXT_PATH =
  /[A-Za-z]:[\\/][^\s<>"'`|*?()[\]{}，。；、]+|\\\\[^\s<>"'`|*?()[\]{}，。；、]+|\/(?:Users|home|opt|var|tmp|usr|private|Volumes)\/[^\s<>"'`|*?()[\]{}，。；、]+|(?:[\w.+@-]+[\\/]){5,}[\w.+@-]+/g;


/** 长本机路径的展示名。不够长、或不是路径时返回 null。 */
export function shortenLocalPath(raw: string): string | null {
  const path = raw.trim();
  if (!isLocalPath(path)) return null;
  const parts = pathSegments(path);
  const absolute = isAbsoluteLocal(path);
  const long = absolute ? parts.length >= 4 || path.length >= 48 : parts.length >= 6 || path.length >= 72;
  if (!long) return null;
  const file = parts[parts.length - 1];
  const parent = parts[parts.length - 2];
  if (!file) return null;
  if (!parent || parent.endsWith(":")) return `…/${file}`;
  return `…/${parent}/${file}`;
}

export function splitTextPaths(text: string): Inline[] {
  if (!text) return [];
  const out: Inline[] = [];
  const re = new RegExp(TEXT_PATH.source, "g");
  let last = 0;
  for (const match of text.matchAll(re)) {
    const start = match.index ?? 0;
    if (start < last) continue;
    const prev = start > 0 ? text[start - 1] : "";
    if (prev && (/[\w/]/.test(prev) || (prev === ":" && text[start - 2] === "/"))) continue;
    const raw = match[0].replace(/[.,;:]+$/g, "");
    const display = raw ? shortenLocalPath(raw) : null;
    if (!display) continue;
    if (start > last) out.push({ type: "text", text: text.slice(last, start) });
    out.push({ type: "path", display, full: raw });
    last = start + raw.length;
  }
  if (last < text.length) out.push({ type: "text", text: text.slice(last) });
  return out.length > 0 ? out : [{ type: "text", text }];
}

export function isLocalPath(path: string): boolean {
  return isAbsoluteLocal(path) || isRelativePath(path);
}

export function isAbsoluteLocal(path: string): boolean {
  return (
    /^[A-Za-z]:[\\/]/.test(path) ||
    /^\\\\[^\\]+\\/.test(path) ||
    /^\/(?:Users|home|opt|var|tmp|usr|private|Volumes)\//.test(path)
  );
}

export function isRelativePath(path: string): boolean {
  if (/[\s"'`<>|*?]/.test(path) || path.includes("://")) return false;
  return /^(?:[\w.+@-]+[\\/]){2,}[\w.+@-]+$/.test(path);
}

export function pathSegments(path: string): string[] {
  return path.replace(/\\/g, "/").split("/").filter(Boolean);
}

export function codeDisplayLines(text: string): Inline[][] {
  if (!text) return [];
  return text.split("\n").map((line) => splitTextPaths(line));
}
