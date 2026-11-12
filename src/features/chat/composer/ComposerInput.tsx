import { useLayoutEffect, useRef, type ClipboardEvent, type KeyboardEvent, type RefObject } from "react";

import {
  atomArrow,
  atomDeleteRange,
  atomRanges,
  growSelection,
  snapCaret,
  withTrailingSpace,
  type AtomRange,
} from "./composer-atoms";
import type { ComposerToken } from "./file-refs";

/** 至少两行，内容多了跟着长高，到 `max-h-40` 后在框里滚动。折行也算行数。 */
const MIN_HEIGHT_PX = 48;
const MAX_HEIGHT_PX = 160;

/** 输入框和底下画标签的那层共用：字号、行高、内边距、折行必须一致，标签才对得上字。 */
const TEXT_BOX = "w-full min-w-0 max-w-full px-2 text-sm leading-6 whitespace-pre-wrap break-words [scrollbar-gutter:stable]";

export function ComposerInput({
  text,
  tokens,
  placeholder,
  disabled,
  textareaRef,
  onChange,
  onCaret,
  onPaste,
  onKeyDown,
}: {
  text: string;
  /** 技能和文件引用画成标签。没有标签时输入框照常显示文字。 */
  tokens: ComposerToken[];
  placeholder: string;
  disabled: boolean;
  textareaRef: RefObject<HTMLTextAreaElement>;
  onChange: (value: string, element: HTMLTextAreaElement) => void;
  onCaret: (element: HTMLTextAreaElement) => void;
  onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
}) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const decorated = tokens.some((token) => token.kind !== "text");
  const atoms = atomRanges(tokens);

  /** 标签当一个字处理：删除、方向键先看这里，没碰到标签再交给作曲栏。 */
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const element = event.currentTarget;
    if (atoms.length > 0 && !event.nativeEvent.isComposing && !event.altKey && !event.metaKey) {
      const { selectionStart: start, selectionEnd: end } = element;
      if (event.key === "Backspace" || event.key === "Delete") {
        const range = atomDeleteRange(atoms, start, end, event.key);
        if (range) {
          event.preventDefault();
          removeRange(element, start === end ? withTrailingSpace(element.value, range) : range, onChange);
          return;
        }
      } else if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && !event.shiftKey && start === end) {
        const next = atomArrow(atoms, start, event.key);
        if (next != null) {
          event.preventDefault();
          element.setSelectionRange(next, next);
          onCaret(element);
          return;
        }
      }
    }
    onKeyDown(event);
  };

  /** 点进标签中间或拖选到半个标签时，挪到标签边上。 */
  const select = (element: HTMLTextAreaElement) => {
    if (atoms.length > 0) {
      const { selectionStart: start, selectionEnd: end } = element;
      if (start === end) {
        const snapped = snapCaret(atoms, start);
        if (snapped !== start) element.setSelectionRange(snapped, snapped);
      } else {
        const grown = growSelection(atoms, start, end);
        if (grown.start !== start || grown.end !== end) {
          element.setSelectionRange(grown.start, grown.end, element.selectionDirection);
        }
      }
    }
    onCaret(element);
  };

  useLayoutEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(MAX_HEIGHT_PX, Math.max(MIN_HEIGHT_PX, element.scrollHeight))}px`;
    if (backdropRef.current) backdropRef.current.scrollTop = element.scrollTop;
  }, [text, textareaRef, decorated]);

  return (
    <div className="relative min-w-0">
      {decorated ? (
        <div
          ref={backdropRef}
          aria-hidden
          data-composer-tokens
          className={`pointer-events-none absolute inset-0 overflow-hidden text-wb-fg ${TEXT_BOX}`}
        >
          {tokens.map((token, index) =>
            token.kind === "text" ? (
              <span key={index}>{token.text}</span>
            ) : (
              <span
                key={index}
                data-token={token.kind}
                className={
                  token.kind === "skill"
                    ? "rounded-[5px] bg-wb-skill-soft text-wb-skill shadow-[0_0_0_2px_var(--color-wb-skill-soft)]"
                    : "rounded-[5px] bg-wb-accent-soft text-wb-accent shadow-[0_0_0_2px_var(--color-wb-accent-soft)]"
                }
              >
                {token.text}
              </span>
            ),
          )}
          {/* 末尾换行时 textarea 会多出一行，这里补上，滚动高度才一致。 */}
          {"​"}
        </div>
      ) : null}
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(event) => onChange(event.target.value, event.target)}
        onSelect={(event) => select(event.currentTarget)}
        // 点击和上下键、Home / End 之后 onSelect 不一定来，这里再对一次。
        onMouseUp={(event) => select(event.currentTarget)}
        onKeyUp={(event) => select(event.currentTarget)}
        onScroll={(event) => {
          if (backdropRef.current) backdropRef.current.scrollTop = event.currentTarget.scrollTop;
        }}
        onPaste={onPaste}
        onKeyDown={keyDown}
        placeholder={placeholder}
        disabled={disabled}
        rows={2}
        className={`relative block max-h-40 resize-none overflow-x-hidden bg-transparent placeholder:text-wb-dim focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 ${TEXT_BOX} ${
          decorated ? "text-transparent caret-wb-fg" : "text-wb-fg"
        }`}
      />
    </div>
  );
}

/** 删掉整个标签。走浏览器的编辑命令，Ctrl+Z 能撤回；不支持时直接改文字。 */
function removeRange(
  element: HTMLTextAreaElement,
  range: AtomRange,
  onChange: (value: string, element: HTMLTextAreaElement) => void,
) {
  element.setSelectionRange(range.start, range.end);
  if (document.execCommand("delete")) return;
  const value = element.value.slice(0, range.start) + element.value.slice(range.end);
  element.value = value;
  element.setSelectionRange(range.start, range.start);
  onChange(value, element);
}
