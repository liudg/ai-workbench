import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ArrowUp, Plus, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { commentedDraft, type TextSnippet, type TextSnippetDraft } from "@/shared/text-snippet";
import { usePanelOptional } from "../core/PanelProvider";

/** 一段要评论的行。scope 区分同一视图里的不同文件或差异的左右两栏，start/end 是行序号。 */
export interface CommentSpan {
  scope: string;
  start: number;
  end: number;
}

export interface LineComments {
  /** 正在拖选或已经打开评论框的那段行。 */
  span: CommentSpan | null;
  editing: boolean;
  /** 从选区打开时带着选中的原文；从行号栏打开时为空，按整行取。 */
  draft: TextSnippetDraft | null;
  beginDrag: (scope: string, row: number) => void;
  open: (span: CommentSpan, draft: TextSnippetDraft | null) => void;
  close: () => void;
}

interface CommentState {
  span: CommentSpan | null;
  anchor: number;
  editing: boolean;
  draft: TextSnippetDraft | null;
}

const IDLE: CommentState = { span: null, anchor: 0, editing: false, draft: null };

/** 行号栏的蓝色加号按下后可以往下拖，松开就在最后一行下面打开评论框。 */
export function useLineComments(): LineComments {
  const [state, setState] = useState<CommentState>(IDLE);
  const dragging = state.span !== null && !state.editing;

  useEffect(() => {
    if (!dragging) return;
    const onMove = (event: MouseEvent) => {
      const row = commentRowAt(event.clientX, event.clientY);
      setState((prev) => {
        if (!prev.span || prev.editing || !row || row.scope !== prev.span.scope) return prev;
        const start = Math.min(prev.anchor, row.row);
        const end = Math.max(prev.anchor, row.row);
        if (start === prev.span.start && end === prev.span.end) return prev;
        return { ...prev, span: { scope: prev.span.scope, start, end } };
      });
    };
    const onUp = () => setState((prev) => (prev.span && !prev.editing ? { ...prev, editing: true } : prev));
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging]);

  const beginDrag = useCallback((scope: string, row: number) => {
    setState({ span: { scope, start: row, end: row }, anchor: row, editing: false, draft: null });
  }, []);
  const open = useCallback((span: CommentSpan, draft: TextSnippetDraft | null) => {
    setState({ span, anchor: span.start, editing: true, draft });
  }, []);
  const close = useCallback(() => setState(IDLE), []);

  return { span: state.span, editing: state.editing, draft: state.draft, beginDrag, open, close };
}

export function spanCovers(comments: LineComments | null | undefined, scope: string, row: number): boolean {
  const span = comments?.span;
  return Boolean(span && span.scope === scope && row >= span.start && row <= span.end);
}

export function boxBelow(comments: LineComments | null | undefined, scope: string, row: number): boolean {
  return Boolean(comments?.editing && comments.span?.scope === scope && comments.span.end === row);
}

/** 行上要带的属性，拖选时靠它认出鼠标下面是哪一行。 */
export function commentRowProps(scope: string, row: number) {
  return { "data-comment-scope": scope, "data-comment-row": row };
}

function commentRowAt(x: number, y: number): { scope: string; row: number } | null {
  return commentRowOf(document.elementFromPoint(x, y));
}

/** 节点所在的可评论行。 */
export function commentRowOf(node: Node | null | undefined): { scope: string; row: number } | null {
  const element = node instanceof Element ? node : node?.parentElement;
  const row = element?.closest("[data-comment-row]");
  if (!row) return null;
  const index = Number(row.getAttribute("data-comment-row"));
  const scope = row.getAttribute("data-comment-scope");
  if (scope === null || !Number.isInteger(index)) return null;
  return { scope, row: index };
}

function commentRangeLabel(start: number, end: number): string {
  if (start === end) return DESKTOP_ZH.commentLine.replace("{line}", String(start));
  return DESKTOP_ZH.commentLines.replace("{start}", String(start)).replace("{end}", String(end));
}

const NO_SNIPPETS: readonly TextSnippet[] = [];
const noSubscribe = () => () => {};

export interface SavedComments {
  /** 按被评论的最后一行（行号）分好。 */
  byLine: ReadonlyMap<number, readonly TextSnippet[]>;
  remove: (id: string) => void;
}

/** 这份文件里已经写好、还在作曲栏里等着发的评论。发出去或移除后就不显示了。 */
export function useSavedComments(path: string): SavedComments | null {
  const panel = usePanelOptional();
  const source = panel?.data.textSnippets;
  const sessionId = panel?.sessionId ?? "";
  const snippets = useSyncExternalStore(source?.subscribe ?? noSubscribe, () =>
    source ? source.read(sessionId) : NO_SNIPPETS,
  );
  return useMemo(() => {
    if (!panel || !path) return null;
    const byLine = new Map<number, TextSnippet[]>();
    for (const snippet of snippets) {
      if (!snippet.note || snippet.path !== path || snippet.end == null) continue;
      const list = byLine.get(snippet.end) ?? [];
      list.push(snippet);
      byLine.set(snippet.end, list);
    }
    return { byLine, remove: (id: string) => panel.data.removeTextSnippet(sessionId, id) };
  }, [panel, path, sessionId, snippets]);
}

/** 写好的评论留在被评论的行下面。悬停出现移除。 */
export function SavedComment({ snippet, onRemove }: { snippet: TextSnippet; onRemove: () => void }) {
  const label = snippet.start == null ? "" : commentRangeLabel(snippet.start, snippet.end ?? snippet.start);
  return (
    <div
      data-saved-comment={snippet.id}
      className="group/comment relative mx-3 my-1.5 rounded-xl border border-wb-border bg-wb-elev px-3 py-2 font-sans"
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      {label ? <p className="text-[12px] leading-5 text-wb-fg-3">{label}</p> : null}
      <p className="mt-0.5 whitespace-pre-wrap break-words text-[13px] leading-5 text-wb-fg">{snippet.note}</p>
      <button
        type="button"
        data-saved-comment-remove
        aria-label={DESKTOP_ZH.textSnippetRemove}
        title={DESKTOP_ZH.textSnippetRemove}
        className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded text-wb-fg-3 opacity-0 transition-colors hover:bg-wb-hover hover:text-wb-fg group-hover/comment:opacity-100 focus-visible:opacity-100"
        onClick={onRemove}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/** 鼠标移到行上时出现在行号栏里。行要有 group 和 relative。 */
export function CommentPlus({
  scope,
  row,
  comments,
  className,
}: {
  scope: string;
  row: number;
  comments: LineComments;
  className?: string;
}) {
  return (
    <button
      type="button"
      tabIndex={-1}
      data-comment-plus
      aria-label={DESKTOP_ZH.addComment}
      title={DESKTOP_ZH.addComment}
      className={cn(
        "absolute top-0.5 z-[1] hidden h-4 w-4 items-center justify-center rounded-full bg-wb-accent text-white shadow group-hover:flex",
        className,
      )}
      onMouseDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        comments.beginDrag(scope, row);
      }}
      onClick={(event) => event.stopPropagation()}
    >
      <Plus className="h-3 w-3" strokeWidth={3} />
    </button>
  );
}

/**
 * 评论框展开在被评论的最后一行下面。Enter 提交，Shift+Enter 换行，Esc 取消。
 * 引用的内容在打开时定下来，之后差异刷新或换显示方式都不会换成别的行。
 */
export function LineCommentBox({
  draft,
  onSubmit,
  onCancel,
}: {
  draft: TextSnippetDraft;
  onSubmit: (draft: TextSnippetDraft) => void;
  onCancel: () => void;
}) {
  const [base] = useState(draft);
  const [note, setNote] = useState("");
  const label = base.start == null ? "" : commentRangeLabel(base.start, base.end ?? base.start);
  const boxRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    boxRef.current?.scrollIntoView({ block: "nearest" });
    areaRef.current?.focus({ preventScroll: true });
  }, []);
  useLayoutEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    area.style.height = "auto";
    area.style.height = `${area.scrollHeight}px`;
  }, [note]);
  const ready = note.trim().length > 0;
  const submit = () => {
    const next = ready ? commentedDraft(base, note) : null;
    if (next) onSubmit(next);
  };
  return (
    <div
      ref={boxRef}
      data-line-comment-box
      className="mx-3 my-1.5 rounded-xl border border-wb-border-strong bg-wb-elev px-3 py-2 font-sans transition-colors focus-within:border-wb-accent"
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
    >
      {label ? <p className="text-[12px] leading-5 text-wb-fg-2">{label}</p> : null}
      <div className="mt-1 flex items-end gap-2">
        <textarea
          ref={areaRef}
          rows={1}
          value={note}
          placeholder={DESKTOP_ZH.addComment}
          aria-label={DESKTOP_ZH.addComment}
          className="max-h-40 min-w-0 flex-1 resize-none bg-transparent text-[13px] leading-5 text-wb-fg outline-none placeholder:text-wb-fg-3"
          onChange={(event) => setNote(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              onCancel();
              return;
            }
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <button
          type="button"
          data-line-comment-cancel
          aria-label="取消"
          title="取消 (Esc)"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-wb-fg-3 transition-colors hover:bg-wb-hover hover:text-wb-fg"
          onMouseDown={(event) => event.preventDefault()}
          onClick={onCancel}
        >
          <X className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          data-line-comment-submit
          aria-label={DESKTOP_ZH.addComment}
          title={DESKTOP_ZH.addComment}
          disabled={!ready}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-wb-primary text-wb-primary-fg transition-colors hover:bg-wb-primary-hover disabled:bg-wb-active disabled:text-wb-fg-3"
          onMouseDown={(event) => event.preventDefault()}
          onClick={submit}
        >
          <ArrowUp className="h-3.5 w-3.5" strokeWidth={2.5} />
        </button>
      </div>
    </div>
  );
}
