import { previewKindForPath } from "../core/preview-kind.ts";
import { pinnedScore, type OpenTarget } from "../core/registry.ts";

export function matchHtml(target: OpenTarget): number {
  const pinned = pinnedScore(target, "html");
  if (pinned != null) return pinned;
  if (target.kind === "blank" || target.kind === "url") return 100;
  if (target.kind === "file" && target.line == null && previewKindForPath(target.path) === "html") return 80;
  return 0;
}

export function matchMarkdown(target: OpenTarget): number {
  const pinned = pinnedScore(target, "markdown");
  if (pinned != null) return pinned;
  if (target.kind === "file" && target.line == null && previewKindForPath(target.path) === "markdown") {
    return 80;
  }
  return 0;
}

export function matchImage(target: OpenTarget): number {
  const pinned = pinnedScore(target, "image");
  if (pinned != null) return pinned;
  if (target.kind === "file" && previewKindForPath(target.path) === "image") return 95;
  return 0;
}

export function matchText(target: OpenTarget): number {
  const pinned = pinnedScore(target, "text");
  if (pinned != null) return pinned;
  if (target.kind === "blocked") return 70;
  if (target.kind === "file" && target.line != null) return 90;
  if (target.kind === "file") return 10;
  return 0;
}

export function matchDiff(target: OpenTarget): number {
  return target.kind === "diff" ? 100 : 0;
}

export function matchTerminal(target: OpenTarget): number {
  return target.kind === "custom" && target.type === "terminal" ? 100 : 0;
}

export function matchOpenFiles(target: OpenTarget): number {
  return target.kind === "custom" && target.type === "open-files" ? 100 : 0;
}
