import { useLayoutEffect, type ClipboardEvent, type KeyboardEvent, type RefObject } from "react";

/** 至少两行，内容多了跟着长高，到 `max-h-40` 后在框里滚动。折行也算行数。 */
const MIN_HEIGHT_PX = 48;
const MAX_HEIGHT_PX = 160;

export function ComposerInput({
  text,
  placeholder,
  disabled,
  textareaRef,
  onChange,
  onCaret,
  onPaste,
  onKeyDown,
}: {
  text: string;
  placeholder: string;
  disabled: boolean;
  textareaRef: RefObject<HTMLTextAreaElement>;
  onChange: (value: string, element: HTMLTextAreaElement) => void;
  onCaret: (element: HTMLTextAreaElement) => void;
  onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
}) {
  useLayoutEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(MAX_HEIGHT_PX, Math.max(MIN_HEIGHT_PX, element.scrollHeight))}px`;
  }, [text, textareaRef]);

  return (
    <textarea
      ref={textareaRef}
      value={text}
      onChange={(event) => onChange(event.target.value, event.target)}
      onSelect={(event) => onCaret(event.currentTarget)}
      onPaste={onPaste}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      disabled={disabled}
      rows={2}
      className="max-h-40 w-full min-w-0 max-w-full resize-none overflow-x-hidden bg-transparent px-2 text-sm leading-6 text-[#e8e8e8] placeholder:text-[#666] focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
    />
  );
}
