import { DESKTOP_ZH } from "../../../shared/strings/desktop-zh.ts";
import { baseName } from "../files/path.ts";
import { lineFromHref, resolvePreviewPath } from "./preview-kind.ts";
import { payloadTitle, type OpenTarget } from "./registry.ts";

let browserSerial = 0;

export function targetFromHref(projectPath: string, href: string, line?: number): OpenTarget {
  const trimmed = href.trim();
  if (/^https?:\/\//i.test(trimmed)) return { kind: "url", url: trimmed };
  const lineNo = line ?? lineFromHref(trimmed);
  const resolved = resolvePreviewPath(projectPath, trimmed);
  if (!resolved) {
    return {
      kind: "blocked",
      href: trimmed,
      line: lineNo,
      message: "只能预览当前项目里的文件",
    };
  }
  return { kind: "file", path: resolved, line: lineNo };
}

export function tabIdFor(target: OpenTarget): string {
  switch (target.kind) {
    case "blank":
      browserSerial += 1;
      return `browser:${Date.now()}-${browserSerial}`;
    case "url":
      return `web:${target.url}`;
    case "file":
      return `doc:${target.path.toLowerCase()}`;
    case "blocked":
      return `blocked:${target.href}`;
    case "diff":
      return target.id;
    case "custom":
      return `custom:${target.type}`;
    default:
      return "tab:unknown";
  }
}

/** 加载完成前标签就能显示的载荷。查看器的 title() 只读 payload。 */
export function initialPayload(target: OpenTarget): unknown {
  switch (target.kind) {
    case "blank":
      return { title: DESKTOP_ZH.browserNewTab, path: "", text: "", truncated: false };
    case "url":
      return {
        title: baseName(target.url) || DESKTOP_ZH.browserNewTab,
        path: "",
        url: target.url,
        text: "",
        truncated: false,
      };
    case "file":
      return {
        title: baseName(target.path),
        path: target.path,
        line: target.line,
        text: "",
        truncated: false,
      };
    case "blocked":
      return {
        title: baseName(target.href) || "文件",
        path: target.href,
        line: target.line,
        text: "",
        truncated: false,
        error: target.message,
      };
    case "diff":
      return { title: target.title, files: target.files };
    case "custom":
      if (target.type === "open-files") return { title: DESKTOP_ZH.openFiles, type: target.type };
      return target.data && typeof target.data === "object" ? { ...(target.data as object) } : { type: target.type };
    default:
      return {};
  }
}

export function mergeLoadedPayload(current: unknown, loaded: unknown): unknown {
  if (!loaded || typeof loaded !== "object") return loaded;
  const loadedTitle = payloadTitle(loaded);
  if (loadedTitle) return loaded;
  const currentTitle = payloadTitle(current);
  if (!currentTitle) return loaded;
  return { ...(loaded as object), title: currentTitle };
}

export function errorPayload(current: unknown, message: string): unknown {
  const title = payloadTitle(current);
  const base = current && typeof current === "object" ? { ...(current as object) } : {};
  return { ...base, ...(title ? { title } : {}), error: message };
}

export function lineOf(payload: unknown): number | null {
  if (!payload || typeof payload !== "object" || !("line" in payload)) return null;
  const line = (payload as { line?: unknown }).line;
  return typeof line === "number" && Number.isInteger(line) && line >= 1 ? line : null;
}

export function withLine(payload: unknown, line: number | null): unknown {
  if (payload && typeof payload === "object") return { ...(payload as object), line };
  return { line };
}
