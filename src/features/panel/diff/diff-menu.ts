import { DESKTOP_ZH } from "../../../shared/strings/desktop-zh.ts";

export interface DiffMenuEntry {
  id: string;
  label: string;
  kind: "action" | "check" | "disabled" | "separator";
}

/** 差异 `···` 菜单，顺序跟录屏 f0085 一致。 */
export function diffMenuEntries(): DiffMenuEntry[] {
  return [
    { id: "refresh", label: DESKTOP_ZH.diffRefresh, kind: "action" },
    { id: "wrap", label: DESKTOP_ZH.diffWrap, kind: "action" },
    { id: "unified", label: DESKTOP_ZH.diffUnified, kind: "action" },
    { id: "expand", label: DESKTOP_ZH.diffExpand, kind: "action" },
    { id: "sep", label: "", kind: "separator" },
    { id: "load-full", label: DESKTOP_ZH.diffLoadFull, kind: "check" },
    { id: "render", label: DESKTOP_ZH.diffRender, kind: "check" },
    { id: "word", label: DESKTOP_ZH.diffWord, kind: "check" },
    { id: "hide-space", label: DESKTOP_ZH.diffHideSpace, kind: "action" },
    { id: "hide-imports", label: DESKTOP_ZH.diffHideImports, kind: "action" },
    { id: "copy-apply", label: DESKTOP_ZH.diffCopyApply, kind: "disabled" },
  ];
}
