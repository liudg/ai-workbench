import type { ClipboardEvent, KeyboardEvent, RefObject } from "react";

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
      rows={Math.min(6, Math.max(2, text.split("\n").length))}
      className="max-h-40 w-full min-w-0 max-w-full resize-none overflow-x-hidden bg-transparent px-2 text-sm leading-6 text-zinc-100 placeholder:text-zinc-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
    />
  );
}
