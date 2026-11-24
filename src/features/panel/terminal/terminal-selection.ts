import { DESKTOP_ZH } from "../../../shared/strings/desktop-zh.ts";
import type { TextSnippetDraft } from "../../../shared/text-snippet.ts";

export interface TerminalSelectionRange {
  start: { x: number; y: number };
  end: { x: number; y: number };
}

export interface TerminalSelectionSource {
  hasSelection(): boolean;
  getSelection(): string;
  getSelectionPosition(): TerminalSelectionRange | undefined;
}

/** 足够包住正文里已有反引号串的围栏，至少三个反引号。 */
export function terminalCodeFence(body: string): string {
  let length = 3;
  for (const match of body.matchAll(/`+/g)) {
    if (match[0].length >= length) length = match[0].length + 1;
  }
  return "`".repeat(length);
}

/** 终端选区拼成围栏引用：` ```terminal:12-25 ` 或 ` ```terminal:12 `。 */
export function formatTerminalSelectionQuote(
  body: string,
  start: number | null,
  end: number | null,
): string {
  const clean = body.replace(/\r\n?/g, "\n").replace(/\s+$/, "");
  if (!clean.trim()) return "";
  const fence = terminalCodeFence(clean);
  const loc =
    start != null && start >= 1
      ? end != null && end > start
        ? `:${start}-${end}`
        : `:${start}`
      : "";
  return `${fence}terminal${loc}\n${clean}\n${fence}`;
}

/**
 * 读取 xterm 当前选区并转成作曲栏文本片。
 * 注意 xterm 5.x 的 `getSelectionPosition()` 返回 0-based 缓冲区行号（首行为 0），这里统一转成 1-based。
 */
export function terminalSelectionDraft(
  source: TerminalSelectionSource | null | undefined,
  title?: string,
): TextSnippetDraft | null {
  if (!source || !source.hasSelection()) return null;
  const raw = source.getSelection();
  if (!raw) return null;

  let normalized = raw.replace(/\r\n?/g, "\n");
  const pos = source.getSelectionPosition();

  let startRow: number | null = null;
  let endRow: number | null = null;

  if (pos && Number.isFinite(pos.start.y) && Number.isFinite(pos.end.y)) {
    const forward =
      pos.start.y < pos.end.y || (pos.start.y === pos.end.y && pos.start.x <= pos.end.x);
    const first = forward ? pos.start : pos.end;
    const last = forward ? pos.end : pos.start;
    startRow = Math.max(0, Math.floor(first.y));
    endRow = Math.max(startRow, Math.floor(last.y));

    // 三击或拖到下一行第 0 列时，选区终点落在下一行开头，实际未包含下一行正文。
    if (last.x === 0 && endRow > startRow) {
      endRow -= 1;
      if (normalized.endsWith("\n")) {
        normalized = normalized.slice(0, -1);
      }
    }
  }

  while (/\n[ \t]*$/.test(normalized)) {
    normalized = normalized.replace(/\n[ \t]*$/, "");
    if (startRow !== null && endRow !== null) {
      endRow = Math.max(startRow, endRow - 1);
    }
  }

  const body = normalized.replace(/[ \t]+$/, "");
  if (!body.trim()) return null;

  const start = startRow !== null ? startRow + 1 : null;
  const end = startRow !== null && endRow !== null ? Math.max(startRow + 1, endRow + 1) : null;
  const path = title?.trim() || DESKTOP_ZH.terminal;
  const quote = formatTerminalSelectionQuote(body, start, end);
  if (!quote) return null;

  return {
    path,
    body,
    start,
    end,
    quote,
  };
}

/** 键盘全选等没有鼠标松开坐标时，按选区末尾单元格在屏幕上的位置定位浮动工具条。 */
export function terminalSelectionFallbackPoint(term: {
  cols: number;
  rows: number;
  element?: HTMLElement;
  buffer: { active: { viewportY: number } };
  getSelectionPosition(): TerminalSelectionRange | undefined;
}): { x: number; y: number } | null {
  const screen = term.element?.querySelector(".xterm-screen") ?? term.element;
  if (!screen) return null;
  const rect = screen.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const pos = term.getSelectionPosition();
  if (!pos || term.cols <= 0 || term.rows <= 0) {
    return { x: rect.left + Math.min(rect.width - 16, 120), y: rect.top + 32 };
  }
  const endRow = pos.end.x === 0 && pos.end.y > pos.start.y ? pos.end.y - 1 : pos.end.y;
  const endCol = pos.end.x === 0 && pos.end.y > pos.start.y ? term.cols : pos.end.x;
  const viewRow = Math.min(term.rows - 1, Math.max(0, endRow - term.buffer.active.viewportY));
  const clampedCol = Math.min(term.cols, Math.max(1, endCol));
  const cellWidth = rect.width / term.cols;
  const cellHeight = rect.height / term.rows;
  return {
    x: Math.round(rect.left + clampedCol * cellWidth),
    y: Math.round(rect.top + (viewRow + 1) * cellHeight),
  };
}
