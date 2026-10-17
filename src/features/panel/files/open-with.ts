import { DESKTOP_ZH } from "../../../shared/strings/desktop-zh.ts";

export type OpenWithAction = "default" | "choose";

export interface OpenWithItem {
  id: OpenWithAction;
  label: string;
}

/** 下拉里始终有系统默认程序。选择应用只在这个系统做得到时出现。 */
export function openWithActions(chooseApp: boolean): OpenWithItem[] {
  const items: OpenWithItem[] = [{ id: "default", label: DESKTOP_ZH.openFileDefault }];
  if (chooseApp) items.push({ id: "choose", label: DESKTOP_ZH.openFileChoose });
  return items;
}
