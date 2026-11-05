import { useEffect, useState } from "react";

import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";

type Editable = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

const TEXT_INPUTS = new Set(["", "text", "search", "url", "email", "password", "number", "tel"]);

/**
 * 整个应用不出浏览器自己的右键菜单。各处自己的菜单照常打开；
 * 输入框里换成剪切、复制、粘贴、全选。
 */
export function NativeMenuGuard() {
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      const field = editableOf(event.target);
      if (!field) return;
      // 输入框只出编辑菜单，不再冒到外面那层的菜单。
      event.stopPropagation();
      setMenu({ x: event.clientX, y: event.clientY, items: editItems(field) });
    };
    window.addEventListener("contextmenu", onContextMenu, true);
    return () => window.removeEventListener("contextmenu", onContextMenu, true);
  }, []);
  if (!menu) return null;
  return <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />;
}

function editableOf(target: EventTarget | null): Editable | null {
  if (!(target instanceof Element)) return null;
  const field = target.closest("input, textarea, [contenteditable]:not([contenteditable='false'])");
  if (field instanceof HTMLInputElement) return TEXT_INPUTS.has(field.type) ? field : null;
  if (field instanceof HTMLTextAreaElement || field instanceof HTMLElement) return field;
  return null;
}

function isReadOnly(field: Editable): boolean {
  if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
    return field.readOnly || field.disabled;
  }
  return !field.isContentEditable;
}

function selectedText(field: Editable): string {
  if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
    const start = field.selectionStart ?? 0;
    const end = field.selectionEnd ?? 0;
    return field.value.slice(start, end);
  }
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return "";
  return field.contains(selection.getRangeAt(0).commonAncestorContainer) ? selection.toString() : "";
}

function editItems(field: Editable): ContextMenuItem[] {
  const readOnly = isReadOnly(field);
  const picked = selectedText(field) !== "";
  // 菜单里点一下会让焦点离开输入框，执行前先放回去，选区还在原处。
  const run = (command: string, value?: string) => {
    field.focus();
    document.execCommand(command, false, value);
  };
  return [
    { id: "cut", label: DESKTOP_ZH.menuCut, disabled: readOnly || !picked, onSelect: () => run("cut") },
    { id: "copy", label: DESKTOP_ZH.menuCopy, disabled: !picked, onSelect: () => run("copy") },
    {
      id: "paste",
      label: DESKTOP_ZH.menuPaste,
      disabled: readOnly,
      onSelect: () => {
        void navigator.clipboard
          ?.readText()
          .then((text) => {
            if (text) run("insertText", text);
          })
          .catch(() => {});
      },
    },
    { id: "sep-select", separator: true },
    { id: "select-all", label: DESKTOP_ZH.menuSelectAll, onSelect: () => run("selectAll") },
  ];
}
