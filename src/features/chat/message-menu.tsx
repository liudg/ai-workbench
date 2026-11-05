// 聊天消息上的右键菜单：复制消息、复制为 Markdown、把消息或选中的一段附加到作曲栏。

import {
  createContext,
  useContext,
  useMemo,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import { writeClipboardRich, writeClipboardText } from "@/shared/clipboard";
import { ContextMenu, type ContextMenuItem } from "@/shared/menu/ContextMenu";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { useChatHost } from "./host";
import { chatSelectionDraft } from "./timeline/chat-selection";

type OpenMessageMenu = (event: ReactMouseEvent<HTMLElement>, markdown: string) => void;

const MessageMenuContext = createContext<OpenMessageMenu | null>(null);

export function MessageMenuProvider({ sessionId, children }: { sessionId: string; children: ReactNode }) {
  const addTextSnippet = useChatHost().addTextSnippet;
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const open = useMemo<OpenMessageMenu>(
    () => (event, markdown) => {
      if (!markdown.trim()) return;
      event.preventDefault();
      const body = event.currentTarget;
      const picked = selectedTextIn(body);
      const items: ContextMenuItem[] = [
        {
          id: "copy-message",
          label: DESKTOP_ZH.copyMessage,
          onSelect: () => void writeClipboardRich(markdown, renderedHtml(body)).catch(() => {}),
        },
        {
          id: "copy-markdown",
          label: DESKTOP_ZH.copyMessageMarkdown,
          onSelect: () => void writeClipboardText(markdown).catch(() => {}),
        },
      ];
      const draft = addTextSnippet ? chatSelectionDraft(picked || markdown) : null;
      if (addTextSnippet && draft) {
        items.push(
          { id: "sep-attach", separator: true },
          {
            id: "attach",
            label: picked ? DESKTOP_ZH.attachSelection : DESKTOP_ZH.attachMessage,
            onSelect: () => {
              addTextSnippet(sessionId, draft);
              if (picked) window.getSelection()?.removeAllRanges();
            },
          },
        );
      }
      setMenu({ x: event.clientX, y: event.clientY, items });
    },
    [addTextSnippet, sessionId],
  );
  return (
    <MessageMenuContext.Provider value={open}>
      {children}
      {menu ? <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} /> : null}
    </MessageMenuContext.Provider>
  );
}

/** 接到消息正文的 onContextMenu 上。外面没有菜单时（预览）为空。 */
export function useMessageMenu(markdown: string): ((event: ReactMouseEvent<HTMLElement>) => void) | undefined {
  const open = useContext(MessageMenuContext);
  return open ? (event) => open(event, markdown) : undefined;
}

function selectedTextIn(root: HTMLElement): string {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return "";
  if (!root.contains(selection.getRangeAt(0).commonAncestorContainer)) return "";
  return selection.toString();
}

/** 正文渲染出来的样子，去掉复制按钮这类控件。 */
function renderedHtml(root: HTMLElement): string {
  const clone = root.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("button, [aria-hidden='true']").forEach((node) => node.remove());
  return clone.innerHTML;
}
