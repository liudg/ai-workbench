import { CHAT_SNIPPET_PATH, type TextSnippetDraft } from "../../../shared/text-snippet.ts";

/** 对话里的选区没有文件。引用块进文本片，不写成代码围栏。 */
export function chatSelectionDraft(text: string): TextSnippetDraft | null {
  const body = text.replace(/\s+$/, "");
  if (!body.trim()) return null;
  const quote = body
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return {
    path: CHAT_SNIPPET_PATH,
    body,
    start: null,
    end: null,
    quote,
  };
}

export function chatDraftFromSelection(root: HTMLElement): TextSnippetDraft | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;
  const host = range.commonAncestorContainer instanceof Element
    ? range.commonAncestorContainer
    : range.commonAncestorContainer.parentElement;
  if (host?.closest("input, textarea, [contenteditable='true']")) return null;
  return chatSelectionDraft(selection.toString());
}
