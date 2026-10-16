import type { McpFeedback } from "./view";

export type McpFeedbackBook = Partial<Record<string, McpFeedback | null>>;

export function writeFeedback(
  book: McpFeedbackBook,
  kind: string,
  feedback: McpFeedback | null,
): McpFeedbackBook {
  return { ...book, [kind]: feedback };
}

export function visibleFeedback(book: McpFeedbackBook, kind: string | null): McpFeedback | null {
  if (!kind) return null;
  return book[kind] ?? null;
}

export function clearSuccess(book: McpFeedbackBook, kind: string): McpFeedbackBook {
  if (book[kind]?.tone !== "success") return book;
  return { ...book, [kind]: null };
}
