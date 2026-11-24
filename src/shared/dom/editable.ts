// 共享的可编辑 DOM 元素判定（供右键编辑菜单与快捷键 inputFocus 上下文复用）。
// 不依赖全局 DOM 构造器在模块加载时存在，兼容纯 Node 单测与浏览器环境。

export type EditableElement = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

const NON_TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  "button",
  "checkbox",
  "radio",
  "submit",
  "reset",
  "file",
  "range",
  "color",
  "hidden",
  "image",
]);

export function asElement(node: EventTarget | Element | null | undefined): Element | null {
  if (!node || typeof node !== "object") return null;
  if ("closest" in node && typeof node.closest === "function") return node as Element;
  if ("parentElement" in node) return (node as { parentElement: Element | null }).parentElement;
  return null;
}

function isTerminalInternalElement(el: Element): boolean {
  if (el.classList?.contains("xterm-helper-textarea")) return true;
  if (el.closest?.("[data-terminal-view]")) return true;
  return false;
}

function isTextInputType(type: string | null | undefined): boolean {
  const normalized = (type ?? "text").toLowerCase();
  return !NON_TEXT_INPUT_TYPES.has(normalized);
}

/**
 * 查找目标所在的可编辑元素（排除 `[data-terminal-view]` 与 `.xterm-helper-textarea`，排除非文本类 input）。
 */
export function findEditableElement(
  target: EventTarget | Element | null | undefined,
  options?: { includeSelect?: boolean },
): EditableElement | null {
  const el = asElement(target);
  if (!el || isTerminalInternalElement(el)) return null;

  const selector = options?.includeSelect
    ? "input, textarea, select, [contenteditable]:not([contenteditable='false'])"
    : "input, textarea, [contenteditable]:not([contenteditable='false'])";
  const field = el.closest?.(selector) ?? null;
  if (!field) {
    if ((el as HTMLElement).isContentEditable) return el as HTMLElement;
    return null;
  }
  if (isTerminalInternalElement(field)) return null;

  const tag = field.tagName?.toLowerCase();
  if (tag === "input") {
    const inputType = (field as HTMLInputElement).type || field.getAttribute?.("type") || "text";
    return isTextInputType(inputType) ? (field as HTMLInputElement) : null;
  }
  if (tag === "textarea") {
    return field as HTMLTextAreaElement;
  }
  if (tag === "select") {
    return options?.includeSelect ? (field as HTMLElement) : null;
  }
  const htmlField = field as HTMLElement;
  if (htmlField.isContentEditable) return htmlField;
  const ce = field.getAttribute?.("contenteditable")?.toLowerCase();
  if (ce === "" || ce === "true" || ce === "plaintext-only") return htmlField;
  return null;
}

export function isEditableTarget(
  target: EventTarget | Element | null | undefined,
  options?: { includeSelect?: boolean },
): boolean {
  return findEditableElement(target, options) !== null;
}
