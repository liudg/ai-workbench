/** 观察到的开面板和弦是 CmdOrCtrl+K 与 CmdOrCtrl+Shift+P。B 切换侧边栏，不带 Shift 的 P 跳转文件。方向键是否回绕未观察，这里到头停住。Tab 跳到下一分组的第一项并回绕。 */

export interface ChordEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat?: boolean;
}

function modified(event: ChordEvent): boolean {
  return !event.altKey && !event.repeat && (event.ctrlKey || event.metaKey);
}

export function isOpenChord(event: ChordEvent): boolean {
  if (!modified(event)) return false;
  const key = event.key.toLowerCase();
  if (key === "k" && !event.shiftKey) return true;
  return key === "p" && event.shiftKey;
}

export function isNewThreadChord(event: ChordEvent): boolean {
  return modified(event) && event.shiftKey && event.key.toLowerCase() === "o";
}

export function isDeleteChord(event: ChordEvent): boolean {
  return modified(event) && event.shiftKey && (event.key === "Delete" || event.key === "Backspace");
}

/** 删除和弦必须把面板打开到删除页。只改 drill 时菜单还关着，快捷键看起来没反应。 */
export function deleteShortcutMenu(_open: boolean): { open: true; drill: "delete" } {
  return { open: true, drill: "delete" };
}

export function isSidebarChord(event: ChordEvent): boolean {
  return modified(event) && !event.shiftKey && event.key.toLowerCase() === "b";
}

export function isQuickOpenChord(event: ChordEvent): boolean {
  return modified(event) && !event.shiftKey && event.key.toLowerCase() === "p";
}

export function moveCursor(index: number, count: number, key: "ArrowDown" | "ArrowUp"): number {
  if (count <= 0) return 0;
  if (key === "ArrowDown") return Math.min(count - 1, index + 1);
  return Math.max(0, index - 1);
}

export function sectionStarts(groups: readonly string[]): number[] {
  const starts: number[] = [];
  let previous = "";
  groups.forEach((group, index) => {
    if (group !== previous) {
      starts.push(index);
      previous = group;
    }
  });
  return starts;
}

export function jumpSection(starts: readonly number[], current: number, direction: 1 | -1): number {
  if (starts.length === 0) return 0;
  let section = 0;
  for (let index = 0; index < starts.length; index += 1) {
    if (starts[index] <= current) section = index;
  }
  const next = (section + direction + starts.length) % starts.length;
  return starts[next] ?? 0;
}
