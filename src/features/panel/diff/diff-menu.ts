import { DESKTOP_ZH } from "../../../shared/strings/desktop-zh.ts";

export type DiffMenuIcon = "file" | "preview" | "word" | "space" | "imports" | "clipboard";

export interface DiffMenuEntry {
  id: "load-full" | "render" | "word" | "hide-space" | "hide-imports" | "copy-apply";
  label: string;
  icon: DiffMenuIcon;
  kind: "check" | "action" | "disabled";
  reason?: string;
}

/**
 * 差异 `···` 菜单。顺序跟 Codex 桌面当前的溢出菜单一致：
 * 加载完整文件、渲染预览、词级差异、隐藏空白、隐藏导入、复制 git apply。
 * 刷新、换行、展开和布局在工具栏上，不放进这个菜单。
 */
export function diffMenuEntries(copy: { enabled: boolean; reason: string }): DiffMenuEntry[] {
  return [
    { id: "load-full", label: DESKTOP_ZH.diffLoadFull, icon: "file", kind: "check" },
    { id: "render", label: DESKTOP_ZH.diffRender, icon: "preview", kind: "check" },
    { id: "word", label: DESKTOP_ZH.diffWord, icon: "word", kind: "check" },
    { id: "hide-space", label: DESKTOP_ZH.diffHideSpace, icon: "space", kind: "check" },
    { id: "hide-imports", label: DESKTOP_ZH.diffHideImports, icon: "imports", kind: "check" },
    {
      id: "copy-apply",
      label: DESKTOP_ZH.diffCopyApply,
      icon: "clipboard",
      kind: copy.enabled ? "action" : "disabled",
      reason: copy.enabled ? undefined : copy.reason,
    },
  ];
}
