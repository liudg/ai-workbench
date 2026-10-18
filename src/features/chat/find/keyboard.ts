/**
 * Codex 默认键位表未观察。包里出现过 `CmdOrCtrl+F` 这串字符，但没有绑到 `findInThread`。
 * 这里用 Ctrl/Cmd+F 打开当前会话的查找，是工作台自己的绑定。
 */
export function isThreadFindChord(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat?: boolean;
}): boolean {
  if (event.altKey || event.shiftKey || event.repeat) return false;
  if (!event.ctrlKey && !event.metaKey) return false;
  return event.key.toLowerCase() === "f";
}
