import { useWorkbench } from "@/store";
import { createTextSnippet, type TextSnippet, type TextSnippetDraft } from "@/shared/text-snippet";

const EMPTY: TextSnippet[] = [];

/** 选区进当前会话的文本片。预览页不直接写 store。 */
export function addSessionTextSnippet(sessionId: string, draft: TextSnippetDraft): boolean {
  if (!sessionId) return false;
  const snippet = createTextSnippet(draft);
  if (!snippet) return false;
  useWorkbench.getState().addTextSnippet(sessionId, snippet);
  return true;
}

export function useSessionTextSnippets(sessionId: string): TextSnippet[] {
  return useWorkbench((state) => state.textSnippets[sessionId] ?? EMPTY);
}
