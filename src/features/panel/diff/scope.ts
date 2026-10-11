import { DESKTOP_ZH } from "../../../shared/strings/desktop-zh.ts";

/** 变更页「上一轮」菜单。已提交、分支在参考里有尖角，子菜单没有打开。 */
export function diffScopeMenu(): { id: string; label: string; submenu: boolean }[] {
  return [
    { id: "turn", label: DESKTOP_ZH.diffPreviousTurn, submenu: false },
    { id: "uncommitted", label: DESKTOP_ZH.diffUncommitted, submenu: false },
    { id: "unstaged", label: DESKTOP_ZH.diffUnstaged, submenu: false },
    { id: "staged", label: DESKTOP_ZH.diffStaged, submenu: false },
    { id: "committed", label: DESKTOP_ZH.diffCommitted, submenu: true },
    { id: "branch", label: DESKTOP_ZH.diffBranch, submenu: true },
  ];
}
