// 同屏有几段聊天时（比如侧边聊天），另开的那段包在一个 `data-chat-scope` 里，主对话不包。
// 查找、审批快捷键这类挂在窗口上的东西，只对焦点所在的那段起作用。

export const CHAT_SCOPE_ATTR = "data-chat-scope";

function scopeOf(node: Element | null | undefined): Element | null {
  return node?.closest(`[${CHAT_SCOPE_ATTR}]`) ?? null;
}

/** 两个节点在同一段聊天里。不在任何一段里的（侧栏、面板、body）算主对话。 */
export function sameChatScope(a: Element | null | undefined, b: Element | null | undefined): boolean {
  return scopeOf(a) === scopeOf(b);
}
