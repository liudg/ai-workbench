import { writeClipboardText } from "@/shared/clipboard";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import type { TextSnippetDraft } from "@/shared/text-snippet";
import type { ContextMenuItem } from "../core/ContextMenu";
import { pathWithLines } from "./selection-quote";

/** 右键点中的那一行。行上带 data-source-line。 */
export function sourceLineAt(target: EventTarget | null): number | null {
  if (!(target instanceof Element)) return null;
  const row = target.closest("[data-source-line]");
  const line = Number(row?.getAttribute("data-source-line"));
  return Number.isInteger(line) && line >= 1 ? line : null;
}

/** 当前选区在 root 里的文字。选区不在 root 里就当没有。 */
function selectedTextIn(root: HTMLElement | null): string {
  const selection = window.getSelection();
  if (!root || !selection || selection.isCollapsed || selection.rangeCount === 0) return "";
  if (!root.contains(selection.getRangeAt(0).commonAncestorContainer)) return "";
  return selection.toString();
}

/**
 * 菜单开头的「添加到对话」「添加评论」。target 是选区或右键点中的那一行；
 * onComment 为空表示这里不能评论，不出这一项。
 */
export function snippetItems(
  target: TextSnippetDraft | null,
  onAdd: (draft: TextSnippetDraft) => void,
  onComment: (() => void) | null,
): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    {
      id: "add-to-chat",
      label: DESKTOP_ZH.addSelectionToChat,
      disabled: !target,
      onSelect: () => {
        if (target) onAdd(target);
        window.getSelection()?.removeAllRanges();
      },
    },
  ];
  if (onComment) {
    items.push({
      id: "add-comment",
      label: DESKTOP_ZH.addComment,
      disabled: target?.start == null,
      onSelect: () => {
        onComment();
        window.getSelection()?.removeAllRanges();
      },
    });
  }
  return items;
}

/** 只读内容区通用的几项：复制、全选。 */
export function clipboardItems(root: HTMLElement | null): ContextMenuItem[] {
  const text = selectedTextIn(root);
  return [
    {
      id: "copy",
      label: DESKTOP_ZH.menuCopy,
      disabled: !text,
      onSelect: () => void writeClipboardText(text).catch(() => {}),
    },
    {
      id: "select-all",
      label: DESKTOP_ZH.menuSelectAll,
      disabled: !root,
      onSelect: () => {
        if (!root) return;
        const range = document.createRange();
        range.selectNodeContents(root);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      },
    },
  ];
}

export function copyPathItem(path: string, start: number | null, end: number | null): ContextMenuItem {
  return {
    id: "copy-path",
    label: start == null ? DESKTOP_ZH.copyPath : DESKTOP_ZH.copyPathLine,
    disabled: !path,
    onSelect: () => void writeClipboardText(pathWithLines(path, start, end)).catch(() => {}),
  };
}
