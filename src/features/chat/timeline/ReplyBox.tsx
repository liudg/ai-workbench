import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";

import { useDismissLayer } from "@/shared/menu/useDismissLayer";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { commentedDraft, textSnippetPreview, type TextSnippetDraft } from "@/shared/text-snippet";

const WIDTH = 360;
const GAP = 8;
const MARGIN = 8;
const HIGHLIGHT = "chat-reply";

/**
 * 对选中的一段写回复，浮在选区上方，选区一直标着。Enter 带着原文放进作曲栏，Shift+Enter 换行，Esc 取消。
 * 对齐 Claude 桌面端的选区「回复」（`epitaxy` 选区回复框，saveLabel「Add to prompt」）。
 */
export function ReplyBox({
  draft,
  range,
  rootRef,
  onSubmit,
  onCancel,
}: {
  draft: TextSnippetDraft;
  range: Range | null;
  rootRef: RefObject<HTMLElement | null>;
  onSubmit: (draft: TextSnippetDraft) => void;
  onCancel: () => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const [note, setNote] = useState("");
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);
  const noteRef = useRef(note);
  noteRef.current = note;
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  useDismissLayer(true, onCancel);

  useLayoutEffect(() => {
    let last: DOMRect | null = null;
    const apply = () => {
      const box = boxRef.current;
      if (!box) return;
      const rect = range?.getBoundingClientRect();
      // 选区所在的回合被虚拟列表卸掉后量不出来，停在上一次的位置。
      if (rect && (rect.width > 0 || rect.height > 0)) last = rect;
      if (!last) return;
      const height = box.offsetHeight;
      const left = Math.min(Math.max(MARGIN, last.left), window.innerWidth - WIDTH - MARGIN);
      let top = last.top - height - GAP;
      if (top < MARGIN) top = Math.min(last.bottom + GAP, window.innerHeight - height - MARGIN);
      setPlace((prev) => (prev && prev.top === top && prev.left === left ? prev : { top, left }));
    };
    apply();
    const root = rootRef.current;
    root?.addEventListener("scroll", apply, true);
    window.addEventListener("resize", apply);
    return () => {
      root?.removeEventListener("scroll", apply, true);
      window.removeEventListener("resize", apply);
    };
  }, [range, rootRef, note]);

  // 量好位置之前框是隐藏的，隐藏时拿不到焦点。
  const shown = place !== null;
  useEffect(() => {
    if (shown) areaRef.current?.focus({ preventScroll: true });
  }, [shown]);

  useEffect(() => {
    const highlights = typeof CSS !== "undefined" ? CSS.highlights : undefined;
    if (!range || !highlights || typeof Highlight === "undefined") return;
    highlights.set(HIGHLIGHT, new Highlight(range));
    return () => {
      highlights.delete(HIGHLIGHT);
    };
  }, [range]);

  useEffect(() => {
    // 点到别处时，还没写字就收起；写了字留着，免得一下点没了。
    const onPointer = (event: MouseEvent) => {
      if (boxRef.current?.contains(event.target as Node)) return;
      if (!noteRef.current.trim()) onCancelRef.current();
    };
    window.addEventListener("mousedown", onPointer);
    return () => window.removeEventListener("mousedown", onPointer);
  }, []);

  useLayoutEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    area.style.height = "auto";
    area.style.height = `${area.scrollHeight}px`;
  }, [note]);

  const ready = note.trim().length > 0;
  const submit = () => {
    const next = ready ? commentedDraft(draft, note) : null;
    if (next) onSubmit(next);
  };

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={boxRef}
      data-reply-box
      className="wb-popover fixed z-[80] rounded-xl p-3"
      style={{ width: WIDTH, top: place?.top ?? -9999, left: place?.left ?? 0, visibility: place ? "visible" : "hidden" }}
    >
      <p className="line-clamp-2 whitespace-pre-wrap break-words border-l-2 border-wb-border-strong pl-2 text-[12px] leading-5 text-wb-fg-2">
        {textSnippetPreview(draft.body)}
      </p>
      <textarea
        ref={areaRef}
        rows={1}
        value={note}
        placeholder={DESKTOP_ZH.replyPlaceholder}
        aria-label={DESKTOP_ZH.reply}
        className="mt-2 max-h-40 w-full resize-none bg-transparent text-[13px] leading-5 text-wb-fg outline-none placeholder:text-wb-dim"
        onChange={(event) => setNote(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <div className="mt-2 flex justify-end">
        <button
          type="button"
          data-reply-submit
          disabled={!ready}
          className="flex items-center gap-1.5 rounded-lg bg-wb-primary px-2.5 py-1 text-xs font-medium text-wb-primary-fg transition-colors hover:bg-wb-primary-hover disabled:bg-wb-hover disabled:text-wb-dim"
          onMouseDown={(event) => event.preventDefault()}
          onClick={submit}
        >
          {DESKTOP_ZH.replyAdd}
          <span aria-hidden className="text-[11px] opacity-60">↵</span>
        </button>
      </div>
    </div>,
    document.body,
  );
}
