import { DESKTOP_ZH } from "../../../shared/strings/desktop-zh.ts";

/** 预览对应 Codex 的 markdown 模式，源码对应 source。 */
export type MarkdownViewMode = "preview" | "source";

const modes = new Map<string, MarkdownViewMode>();

export function markdownViewMode(path: string): MarkdownViewMode {
  if (!path) return "preview";
  return modes.get(path) ?? "preview";
}

export function rememberMarkdownViewMode(path: string, mode: MarkdownViewMode): void {
  if (!path) return;
  modes.set(path, mode);
}

export function nextMarkdownViewMode(mode: MarkdownViewMode): MarkdownViewMode {
  return mode === "preview" ? "source" : "preview";
}

/** 按钮写的是切过去之后的模式，和 Codex 一样。 */
export function markdownModeButtonLabel(mode: MarkdownViewMode): string {
  return mode === "preview" ? DESKTOP_ZH.markdownViewSource : DESKTOP_ZH.markdownViewPreview;
}

export function resetMarkdownViewModes(): void {
  modes.clear();
}
