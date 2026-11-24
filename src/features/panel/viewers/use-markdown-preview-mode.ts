import { useState } from "react";

import {
  markdownModeButtonLabel,
  markdownViewMode,
  nextMarkdownViewMode,
  rememberMarkdownViewMode,
  type MarkdownViewMode,
} from "./markdown-mode.ts";

function resolveInitialMode(path: string, line: number | null | undefined): MarkdownViewMode {
  return line != null ? "source" : markdownViewMode(path);
}

/** 独立 Markdown 预览标签与「打开文件」顶栏/预览共用的预览/源码模式状态。 */
export function useMarkdownPreviewMode(
  path: string,
  line: number | null | undefined,
  enabled = true,
) {
  const placeKey = `${path}:${line ?? ""}`;
  const [modeState, setModeState] = useState<{ key: string; mode: MarkdownViewMode }>(() => ({
    key: placeKey,
    mode: resolveInitialMode(path, line),
  }));

  if (enabled && modeState.key !== placeKey) {
    setModeState({ key: placeKey, mode: resolveInitialMode(path, line) });
  }

  const mode: MarkdownViewMode | null = enabled
    ? modeState.key === placeKey
      ? modeState.mode
      : resolveInitialMode(path, line)
    : null;

  const toggle = () => {
    if (!mode) return;
    const next = nextMarkdownViewMode(mode);
    rememberMarkdownViewMode(path, next);
    setModeState({ key: placeKey, mode: next });
  };

  const openSourceAt = (targetPath: string, targetLine: number) => {
    setModeState({ key: `${targetPath}:${targetLine}`, mode: "source" });
  };

  return {
    mode,
    label: mode ? markdownModeButtonLabel(mode) : null,
    toggle,
    openSourceAt,
  };
}
