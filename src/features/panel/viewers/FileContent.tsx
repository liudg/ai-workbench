import { useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

import { SelectionMenu } from "@/shared/selection/SelectionMenu";
import type { TextSnippetDraft } from "@/shared/text-snippet";
import { sourceLines } from "../core/source-lines";
import { ContextMenu, type ContextMenuItem } from "../core/ContextMenu";
import { clipboardItems, copyPathItem, snippetItems, sourceLineAt } from "./content-menu";
import { fileSelectionDraft } from "./file-selection";
import { useLineComments } from "./line-comments";
import { MarkdownPreview } from "./MarkdownPreview";
import { selectionDraft } from "./selection-quote";
import { SOURCE_SCOPE, SourceView } from "./SourceView";

interface MarkdownToggle {
  label: string;
  onToggle: () => void;
}

/**
 * 打开的一份文本文件：源码或 Markdown 预览。选中文字能加到对话；源码能按行评论；
 * 右键菜单给这几样再加上复制、全选、复制路径。
 */
export function FileContent({
  text,
  view,
  quotePath,
  copyPath,
  onAdd,
  commentable,
  line = null,
  truncated = false,
  markdown = null,
}: {
  text: string;
  view: "source" | "markdown";
  /** 引用里写的路径。 */
  quotePath: string;
  /** 复制给人看的路径，一般相对项目根。 */
  copyPath: string;
  onAdd: (draft: TextSnippetDraft) => void;
  commentable: boolean;
  line?: number | null;
  truncated?: boolean;
  markdown?: MarkdownToggle | null;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const comments = useLineComments();
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const source = view === "source";
  const canComment = source && commentable && Boolean(quotePath);

  const openComment = (draft: TextSnippetDraft) => {
    if (draft.start == null || draft.end == null) return;
    comments.open({ scope: SOURCE_SCOPE, start: draft.start - 1, end: draft.end - 1 }, draft);
  };

  const showMenu = (event: ReactMouseEvent) => {
    const root = rootRef.current;
    if (!root || !quotePath) return;
    event.preventDefault();
    const picked = fileSelectionDraft(root, quotePath);
    const at = source ? sourceLineAt(event.target) : null;
    const lineDraft = at == null ? null : selectionDraft(quotePath, sourceLines(text)[at - 1] ?? "", at, at);
    const target = picked ?? lineDraft;
    const start = picked ? picked.start : at;
    const end = picked ? picked.end : at;
    const items = snippetItems(
      target,
      onAdd,
      canComment
        ? () => {
            if (picked) openComment(picked);
            else if (at != null) comments.open({ scope: SOURCE_SCOPE, start: at - 1, end: at - 1 }, null);
          }
        : null,
    );
    items.push({ id: "sep-clipboard", separator: true }, ...clipboardItems(root));
    items.push({ id: "sep-path", separator: true }, copyPathItem(copyPath, start, end));
    if (markdown) items.push({ id: "markdown-mode", label: markdown.label, onSelect: markdown.onToggle });
    setMenu({ x: event.clientX, y: event.clientY, items });
  };

  return (
    <div ref={rootRef} className="h-full min-h-0" onContextMenu={showMenu}>
      {source ? (
        <SourceView
          text={text}
          line={line}
          truncated={truncated}
          comment={canComment ? { path: quotePath, comments, onAdd } : null}
        />
      ) : (
        <MarkdownPreview text={text} truncated={truncated} />
      )}
      {quotePath ? (
        <SelectionMenu
          rootRef={rootRef}
          readDraft={(root) => fileSelectionDraft(root, quotePath)}
          onAdd={onAdd}
          onComment={canComment ? openComment : undefined}
        />
      ) : null}
      {menu ? <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} /> : null}
    </div>
  );
}
