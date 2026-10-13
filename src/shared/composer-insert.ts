const listeners = new Map<string, Set<(text: string) => void>>();
const pending = new Map<string, string[]>();

/**
 * 把选中的片段放进该会话的作曲栏。
 * 作曲栏还没挂上时先留着，挂上后一次补上。没有文本就不做。
 */
export function insertComposerText(sessionId: string, text: string): boolean {
  const snippet = text.trim();
  if (!sessionId || !snippet) return false;
  const group = listeners.get(sessionId);
  if (!group || group.size === 0) {
    const queued = pending.get(sessionId) ?? [];
    queued.push(snippet);
    pending.set(sessionId, queued);
    return true;
  }
  for (const listener of group) listener(snippet);
  return true;
}

export function subscribeComposerInsert(sessionId: string, listener: (text: string) => void): () => void {
  let group = listeners.get(sessionId);
  if (!group) {
    group = new Set();
    listeners.set(sessionId, group);
  }
  group.add(listener);
  const queued = pending.get(sessionId) ?? [];
  pending.delete(sessionId);
  for (const text of queued) listener(text);
  return () => {
    group.delete(listener);
    if (group.size === 0) listeners.delete(sessionId);
  };
}

export function appendSnippet(current: string, snippet: string): string {
  const next = snippet.trim();
  if (!next) return current;
  const base = current.replace(/\s+$/, "");
  return base ? `${base}\n\n${next}` : next;
}
