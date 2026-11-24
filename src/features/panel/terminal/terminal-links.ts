import type { IBufferRange, ILink, ILinkProvider } from "@xterm/xterm";

export interface TerminalCellLike {
  getWidth(): number;
  getChars(): string;
}

export interface TerminalLineLike {
  readonly isWrapped: boolean;
  readonly length: number;
  getCell(x: number, cell?: TerminalCellLike): TerminalCellLike | undefined;
}

export interface TerminalBufferLike {
  readonly length: number;
  readonly viewportY: number;
  getLine(y: number): TerminalLineLike | undefined;
  getNullCell?(): TerminalCellLike;
}

export type TerminalParsedLink =
  | {
      kind: "url";
      text: string;
      url: string;
      local: boolean;
      range: IBufferRange;
    }
  | {
      kind: "file";
      text: string;
      path: string;
      line: number | null;
      column: number | null;
      range: IBufferRange;
    };

export interface RawDetectedLink {
  kind: "url" | "file";
  start: number;
  end: number;
  text: string;
  url?: string;
  local?: boolean;
  path?: string;
  line?: number | null;
  column?: number | null;
}

interface CellSpan {
  /** 1-based buffer line number */
  y: number;
  /** 1-based inclusive start column */
  startX: number;
  /** 1-based inclusive end column */
  endX: number;
}

const MAX_WRAP_ROWS = 32;
const POSITIVE_CACHE_TTL_MS = 30_000;
const NEGATIVE_CACHE_TTL_MS = 5_000;
const DEFAULT_HOVER_VERIFY_DELAY_MS = 250;

/**
 * 判断网址是否指向本机或内网服务：本机/内网走工作台内置预览浏览器，外网走系统浏览器。
 */
export function isLocalOrIntranetUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const rawHost = parsed.hostname.toLowerCase();
  if (!rawHost) return false;
  const host = rawHost.startsWith("[") && rawHost.endsWith("]") ? rawHost.slice(1, -1) : rawHost;
  if (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host === "::" ||
    host === "0:0:0:0:0:0:0:1"
  ) {
    return true;
  }
  if (host.endsWith(".localhost") || host.endsWith(".local")) return true;

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!ipv4) return false;
  const octets = [Number(ipv4[1]), Number(ipv4[2]), Number(ipv4[3]), Number(ipv4[4])];
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = octets;
  if (a === 127 || a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/** Windows/Linux 用 Ctrl+单击，macOS 用 Cmd+单击，普通单击与拖选不误触跳转。 */
export function isTerminalLinkTrigger(
  event: Pick<MouseEvent, "button" | "ctrlKey" | "metaKey" | "altKey">,
  isMac = detectMacPlatform(),
): boolean {
  if (typeof event.button === "number" && event.button !== 0) return false;
  if (event.altKey) return false;
  return isMac ? Boolean(event.metaKey && !event.ctrlKey) : Boolean(event.ctrlKey && !event.metaKey);
}

function detectMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform = navigator.platform || navigator.userAgent || "";
  return /(?:Mac|iPhone|iPad|iPod)/i.test(platform);
}

/**
 * 沿 `isWrapped` 向前、向后拼出完整的软换行逻辑段，并记录每个 UTF-16 字符对应的 1-based 单元格区间。
 * 宽字符（CJK 等 width=2）占两列，后面的字符起点自动顺延。
 */
export function readWrappedLogicalLine(
  buffer: TerminalBufferLike,
  cols: number,
  bufferLineNumber: number,
): { text: string; cells: CellSpan[]; startLine: number; endLine: number } | null {
  const targetRow = bufferLineNumber - 1;
  if (targetRow < 0 || targetRow >= buffer.length) return null;
  if (!buffer.getLine(targetRow)) return null;

  let startRow = targetRow;
  let walkedBack = 0;
  while (startRow > 0 && walkedBack < MAX_WRAP_ROWS) {
    const cur = buffer.getLine(startRow);
    if (!cur?.isWrapped) break;
    startRow -= 1;
    walkedBack += 1;
  }

  let endRow = targetRow;
  let walkedForward = 0;
  while (endRow + 1 < buffer.length && walkedForward < MAX_WRAP_ROWS) {
    const next = buffer.getLine(endRow + 1);
    if (!next?.isWrapped) break;
    endRow += 1;
    walkedForward += 1;
  }

  const scratch = buffer.getNullCell?.();
  const cells: CellSpan[] = [];
  let text = "";

  for (let row = startRow; row <= endRow; row += 1) {
    const line = buffer.getLine(row);
    if (!line) continue;
    const limit = cols > 0 ? Math.min(line.length, cols) : line.length;
    let rowEnd = -1;
    if (row < endRow) {
      rowEnd = limit - 1;
      if (limit >= 1) {
        const tailCell = line.getCell(limit - 1, scratch);
        const tailIsBlankPadding =
          tailCell !== undefined && tailCell.getWidth() === 1 && tailCell.getChars() === "";
        if (tailIsBlankPadding) {
          const prevCell = limit >= 2 ? line.getCell(limit - 2, scratch) : undefined;
          const prevOccupied =
            limit < 2 ||
            (prevCell !== undefined && (prevCell.getChars() !== "" || prevCell.getWidth() === 0));
          const nextRowCell0 = buffer.getLine(row + 1)?.getCell(0, scratch);
          if (prevOccupied && nextRowCell0?.getWidth() === 2) {
            rowEnd = limit - 2;
          }
        }
      }
    } else {
      for (let col = limit - 1; col >= 0; col -= 1) {
        const cell = line.getCell(col, scratch);
        if (cell && cell.getChars() !== "") {
          rowEnd = col;
          break;
        }
      }
    }
    for (let col = 0; col <= rowEnd; col += 1) {
      const cell = line.getCell(col, scratch);
      if (!cell) continue;
      const width = cell.getWidth();
      if (width === 0) continue;
      const chars = cell.getChars() || " ";
      const cellWidth = Math.max(1, width);
      const maxCol = cols > 0 ? cols : col + cellWidth;
      const span: CellSpan = {
        y: row + 1,
        startX: col + 1,
        endX: Math.min(maxCol, col + cellWidth),
      };
      text += chars;
      for (let i = 0; i < chars.length; i += 1) {
        cells.push(span);
      }
    }
  }

  return {
    text,
    cells,
    startLine: startRow + 1,
    endLine: endRow + 1,
  };
}

/**
 * 解析缓冲区某一行涉及的全部链接（含跨软换行拼接后的链接）。
 * 只返回覆盖了 `bufferLineNumber` 这一物理行的链接。
 */
export function detectLinksForBufferLine(
  buffer: TerminalBufferLike,
  cols: number,
  bufferLineNumber: number,
): TerminalParsedLink[] {
  const logical = readWrappedLogicalLine(buffer, cols, bufferLineNumber);
  if (!logical || !logical.text) return [];
  const rawLinks = scanTextLinks(logical.text);
  const results: TerminalParsedLink[] = [];

  for (const item of rawLinks) {
    if (item.start < 0 || item.end <= item.start || item.end > logical.cells.length) continue;
    const first = logical.cells[item.start]!;
    const last = logical.cells[item.end - 1]!;
    if (bufferLineNumber < first.y || bufferLineNumber > last.y) continue;
    const range: IBufferRange = {
      start: { x: first.startX, y: first.y },
      end: { x: last.endX, y: last.y },
    };
    if (item.kind === "url" && item.url) {
      results.push({
        kind: "url",
        text: item.text,
        url: item.url,
        local: Boolean(item.local),
        range,
      });
    } else if (item.kind === "file" && item.path) {
      results.push({
        kind: "file",
        text: item.text,
        path: item.path,
        line: item.line ?? null,
        column: item.column ?? null,
        range,
      });
    }
  }
  return results;
}

/** 在指定 1-based `{ x: col, y: bufferLineNumber }` 单元格查找命中的终端链接。 */
export function findTerminalLinkAt(
  buffer: TerminalBufferLike,
  cols: number,
  bufferLineNumber: number,
  col: number,
): TerminalParsedLink | null {
  if (col < 1 || bufferLineNumber < 1) return null;
  const width = Math.max(cols, col);
  const links = detectLinksForBufferLine(buffer, cols, bufferLineNumber);
  const target = bufferLineNumber * width + col;
  for (const link of links) {
    const start = link.range.start.y * width + link.range.start.x;
    const end = link.range.end.y * width + link.range.end.x;
    if (target >= start && target <= end) return link;
  }
  return null;
}

/** 把鼠标坐标换算成 xterm 活跃缓冲区的 1-based `{ col, bufferLineNumber }`。 */
export function terminalCellFromPoint(
  term: {
    cols: number;
    rows: number;
    element?: HTMLElement;
    buffer: { active: { viewportY: number; length: number } };
  },
  clientX: number,
  clientY: number,
): { col: number; bufferLineNumber: number } | null {
  const screen = term.element?.querySelector(".xterm-screen");
  if (!screen || term.cols <= 0 || term.rows <= 0) return null;
  const rect = screen.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
    return null;
  }
  const col = Math.min(
    term.cols,
    Math.max(1, Math.floor(((clientX - rect.left) / rect.width) * term.cols) + 1),
  );
  const viewportRow = Math.min(
    term.rows - 1,
    Math.max(0, Math.floor(((clientY - rect.top) / rect.height) * term.rows)),
  );
  const bufferLineNumber = term.buffer.active.viewportY + viewportRow + 1;
  if (bufferLineNumber < 1 || bufferLineNumber > term.buffer.active.length) return null;
  return { col, bufferLineNumber };
}

/** 纯字符串扫描：识别 http(s) URL、file:// URL、带引号路径与各类编译器路径:行:列。 */
export function scanTextLinks(text: string): RawDetectedLink[] {
  if (!text) return [];
  const occupied: Array<{ start: number; end: number }> = [];
  const detected: RawDetectedLink[] = [];

  const overlaps = (start: number, end: number) =>
    occupied.some((span) => start < span.end && end > span.start);

  // 0. 跳过 PowerShell 提示符目录（如 `PS G:\document\ai-workbench>`），保留提示符后面的命令与输出。
  for (const promptMatch of text.matchAll(/(?:^|\n)\s*PS\s+(?:[A-Za-z]:[\\/]|\\\\|\/)[^\r\n>]*>+/g)) {
    const start = promptMatch.index ?? 0;
    occupied.push({ start, end: start + promptMatch[0].length });
  }

  // 1. HTTP / HTTPS URLs
  const urlRe = /https?:\/\/[^\s"'`<>|\u0000-\u001f\u3000-\u303f\uff00-\uffef]+/gi;
  for (const match of text.matchAll(urlRe)) {
    const start = match.index ?? 0;
    const trimmed = trimBalancedTail(match[0]);
    const end = start + trimmed.length;
    if (!trimmed || overlaps(start, end)) continue;
    try {
      const parsed = new URL(trimmed);
      if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) continue;
    } catch {
      continue;
    }
    occupied.push({ start, end });
    detected.push({
      kind: "url",
      start,
      end,
      text: trimmed,
      url: trimmed,
      local: isLocalOrIntranetUrl(trimmed),
    });
  }

  // 2. file:// URLs
  const fileUrlRe = /file:\/\/[^\s"'`<>|\u0000-\u001f\u3000-\u303f\uff00-\uffef]+/gi;
  for (const match of text.matchAll(fileUrlRe)) {
    const start = match.index ?? 0;
    const trimmed = trimFileTokenTail(match[0]);
    const end = start + trimmed.length;
    if (!trimmed || overlaps(start, end)) continue;
    const parsed = parseFileUrlCandidate(trimmed);
    if (!parsed || !isLikelyFilePath(parsed.path, true)) continue;
    occupied.push({ start, end });
    detected.push({
      kind: "file",
      start,
      end,
      text: trimmed,
      path: parsed.path,
      line: parsed.line,
      column: parsed.column,
    });
  }

  // 3. 带单引号或双引号的文件路径（支持路径中含空格，支持引号内外带行号）
  const quotedRe =
    /("([^"\r\n\u0000-\u001f]{2,})"|'([^'\r\n\u0000-\u001f]{2,})')((?::\d+(?::\d+)?(?:-\d+(?::\d+)?)?|\(\d+(?:,\s*\d+)?\)|#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?))?/g;
  for (const match of text.matchAll(quotedRe)) {
    const fullStart = match.index ?? 0;
    const quotedPart = match[1]!;
    const inner = (match[2] ?? match[3] ?? "").trim();
    const outerLoc = match[4] ?? "";
    const fullEnd = fullStart + match[0].length;
    if (!inner || overlaps(fullStart, fullEnd)) continue;

    let extraLen = 0;
    let pythonLine: number | null = null;
    if (!outerLoc) {
      const py = /^,\s*line\s+(\d+)\b/i.exec(text.slice(fullEnd));
      if (py) {
        const num = positiveInt(py[1]);
        if (num !== null && !overlaps(fullStart, fullEnd + py[0].length)) {
          pythonLine = num;
          extraLen = py[0].length;
        }
      }
    }

    const candidateText = outerLoc ? `${inner}${outerLoc}` : inner;
    const parsed = parsePathWithLocation(candidateText);
    if (!parsed || !isLikelyFilePath(parsed.path, true)) continue;

    const spanStart = outerLoc || extraLen > 0 ? fullStart : fullStart + 1;
    const spanEnd = outerLoc
      ? fullEnd
      : extraLen > 0
        ? fullEnd + extraLen
        : fullStart + quotedPart.length - 1;
    occupied.push({ start: fullStart, end: fullEnd + extraLen });
    detected.push({
      kind: "file",
      start: spanStart,
      end: spanEnd,
      text: text.slice(spanStart, spanEnd),
      path: parsed.path,
      line: parsed.line ?? pythonLine,
      column: parsed.column,
    });
  }

  // 4. 未加引号的文件路径与编译器定位（Rust `--> src\main.rs:12:5`、TS `src/app.ts(12,5):`、`src/foo.ts:12:5:` 等）
  const tokenRe =
    /(?:\(\d+(?:,\s*\d+)?\)|[^\s"'`<>|*?,;(\u0000-\u001f\u3000-\u303f\uff00-\uffef]|\([^\s"'`<>|*?,;()\u0000-\u001f\u3000-\u303f\uff00-\uffef]*\))+/g;
  for (const match of text.matchAll(tokenRe)) {
    const rawStart = match.index ?? 0;
    const raw = match[0];
    const rawEnd = rawStart + raw.length;
    if (overlaps(rawStart, rawEnd)) continue;

    const extracted = extractUnquotedFileCandidate(text, rawStart, raw);
    if (!extracted) continue;
    if (overlaps(extracted.start, extracted.end)) continue;

    occupied.push({ start: extracted.start, end: extracted.end });
    detected.push(extracted);
  }

  detected.sort((a, b) => a.start - b.start);
  return detected;
}

function extractUnquotedFileCandidate(
  fullText: string,
  rawStart: number,
  rawToken: string,
): RawDetectedLink | null {
  let start = rawStart;
  let value = rawToken;

  // 剥掉前置 `--flag=` 或 `KEY=`
  const eqPrefix = /^(?:--?[A-Za-z0-9_-]+|[A-Za-z_][A-Za-z0-9_]*)=/.exec(value);
  if (eqPrefix && eqPrefix[0].length < value.length) {
    start += eqPrefix[0].length;
    value = value.slice(eqPrefix[0].length);
  }

  // 剥掉包裹整段路径的外层括号，如 `(src/foo.ts:12:5)`，但保留 Next.js `[id]/page.tsx` 或 `(auth)/login.tsx`
  while (value.length >= 2) {
    const first = value[0]!;
    const close = first === "(" ? ")" : first === "[" ? "]" : first === "{" ? "}" : "";
    if (!close) break;
    const closeAt = findMatchingClose(value, 0, first, close);
    if (closeAt === -1) {
      start += 1;
      value = value.slice(1);
      continue;
    }
    if (closeAt === value.length - 1) {
      start += 1;
      value = value.slice(1, -1);
      continue;
    }
    // 例如 `(src/app.ts(12,5)):` 外层右括号后面还跟着冒号时，先剥掉末尾标点再看
    const trimmedTail = trimFileTokenTail(value);
    if (trimmedTail.length < value.length) {
      value = trimmedTail;
      continue;
    }
    break;
  }

  value = trimFileTokenTail(value);
  if (!value) return null;

  // Git diff 的 `--- a/src/foo.ts`、`+++ b/src/foo.ts`、`diff --git a/src/foo.ts b/src/foo.ts`
  if (/^[ab]\/.+/.test(value)) {
    const before = fullText.slice(Math.max(0, start - 16), start);
    if (/(?:---|(?:\+\+\+)|diff --git(?:\s+\S+)?)\s+$/.test(before)) {
      const stripped = value.slice(2);
      const check = parsePathWithLocation(stripped);
      if (check && isLikelyFilePath(check.path, false)) {
        start += 2;
        value = stripped;
      }
    }
  }

  const parsed = parsePathWithLocation(value);
  if (!parsed || !isLikelyFilePath(parsed.path, false)) return null;

  return {
    kind: "file",
    start,
    end: start + value.length,
    text: value,
    path: parsed.path,
    line: parsed.line,
    column: parsed.column,
  };
}

function findMatchingClose(value: string, openIndex: number, openChar: string, closeChar: string): number {
  let depth = 0;
  for (let i = openIndex; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === openChar) depth += 1;
    else if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function trimBalancedTail(raw: string): string {
  let end = raw.length;
  while (end > 0) {
    const ch = raw[end - 1]!;
    if (/[.,;:!?'"`]/.test(ch)) {
      end -= 1;
      continue;
    }
    if (ch === ")" && countChar(raw, "(", end) < countChar(raw, ")", end)) {
      end -= 1;
      continue;
    }
    if (ch === "]" && countChar(raw, "[", end) < countChar(raw, "]", end)) {
      end -= 1;
      continue;
    }
    if (ch === "}" && countChar(raw, "{", end) < countChar(raw, "}", end)) {
      end -= 1;
      continue;
    }
    break;
  }
  return raw.slice(0, end);
}

function trimFileTokenTail(raw: string): string {
  let end = raw.length;
  while (end > 0) {
    const ch = raw[end - 1]!;
    // 末尾的冒号、分号、逗号、句号（但保留 `..` 自身供后续排除）
    if (ch === ":" || ch === ";" || ch === "," || ch === "!" || ch === "?") {
      end -= 1;
      continue;
    }
    if (ch === "." && end > 2 && raw[end - 2] !== ".") {
      end -= 1;
      continue;
    }
    if (ch === ")" && countChar(raw, "(", end) < countChar(raw, ")", end)) {
      end -= 1;
      continue;
    }
    if (ch === "]" && countChar(raw, "[", end) < countChar(raw, "]", end)) {
      end -= 1;
      continue;
    }
    if (ch === "}" && countChar(raw, "{", end) < countChar(raw, "}", end)) {
      end -= 1;
      continue;
    }
    break;
  }
  return raw.slice(0, end);
}

function countChar(source: string, target: string, limit: number): number {
  let count = 0;
  for (let i = 0; i < limit; i += 1) {
    if (source[i] === target) count += 1;
  }
  return count;
}

export function parseFileUrlCandidate(
  raw: string,
): { path: string; line: number | null; column: number | null } | null {
  if (!/^file:\/\//i.test(raw)) return null;
  let rest = raw.slice("file://".length);
  if (/^localhost[\\/]/i.test(rest)) {
    rest = rest.slice("localhost".length);
  }
  let line: number | null = null;
  let column: number | null = null;

  const hashAt = rest.indexOf("#");
  if (hashAt >= 0) {
    const hash = rest.slice(hashAt);
    const hashMatch = /^#L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?/i.exec(hash);
    if (hashMatch) {
      line = positiveInt(hashMatch[1]);
      column = positiveInt(hashMatch[2]);
    }
    rest = rest.slice(0, hashAt);
  }

  const queryAt = rest.indexOf("?");
  if (queryAt >= 0) rest = rest.slice(0, queryAt);

  try {
    rest = decodeURIComponent(rest);
  } catch {
    // 保留未解码原串
  }

  if (/^\/+[A-Za-z]:[\\/]/.test(rest)) {
    rest = rest.replace(/^\/+/, "");
  } else if (/^[\\/]{2,}[^\\/\s:]+[\\/].+/.test(rest)) {
    rest = `\\\\${rest.replace(/^[\\/]+/, "").replace(/\//g, "\\")}`;
  } else if (!/^[\\/]/.test(rest) && !/^[A-Za-z]:[\\/]/.test(rest) && /^[^\\/\s:]+[\\/].+/.test(rest)) {
    rest = `\\\\${rest.replace(/\//g, "\\")}`;
  }

  const parsed = parsePathWithLocation(rest);
  if (!parsed || !parsed.path) return null;
  return {
    path: parsed.path,
    line: line ?? parsed.line,
    column: column ?? parsed.column,
  };
}

export function parsePathWithLocation(
  input: string,
): { path: string; line: number | null; column: number | null } | null {
  let raw = input.trim();
  if (!raw) return null;

  let line: number | null = null;
  let column: number | null = null;

  const hashAt = raw.indexOf("#");
  if (hashAt > 0) {
    const hash = raw.slice(hashAt);
    const hashMatch = /^#L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?$/i.exec(hash);
    if (!hashMatch) return null;
    line = positiveInt(hashMatch[1]);
    column = positiveInt(hashMatch[2]);
    raw = raw.slice(0, hashAt);
  }

  const parenMatch = /\((\d+)(?:,\s*(\d+))?\)$/.exec(raw);
  if (parenMatch && parenMatch.index > 0) {
    const parsedLine = positiveInt(parenMatch[1]);
    if (parsedLine !== null) {
      line = line ?? parsedLine;
      column = column ?? positiveInt(parenMatch[2]);
      raw = raw.slice(0, parenMatch.index);
    }
  } else {
    const colonMatch = /:(\d+)(?::(\d+))?(?:-\d+(?::\d+)?)?$/.exec(raw);
    if (colonMatch && colonMatch.index > 0) {
      const candidatePath = raw.slice(0, colonMatch.index);
      // 保留盘符 `C:`，只有路径名不为空且不以斜杠结尾时才算行号后缀
      if (candidatePath && !/^[A-Za-z]$/.test(candidatePath) && !/[\\/]$/.test(candidatePath)) {
        const parsedLine = positiveInt(colonMatch[1]);
        if (parsedLine !== null) {
          line = line ?? parsedLine;
          column = column ?? positiveInt(colonMatch[2]);
          raw = candidatePath;
        }
      }
    }
  }

  raw = raw.trim();
  if (!raw) return null;
  return { path: raw, line, column };
}

export function isLikelyFilePath(rawPath: string, allowSpaces: boolean): boolean {
  const path = rawPath.trim();
  if (!path || path === "." || path === ".." || /^\.{3,}$/.test(path)) return false;
  if (!allowSpaces && /\s/.test(path)) return false;
  if (path.startsWith("-") || /[\\/]$/.test(path) || path.includes("://")) return false;
  if (/[<>"|?*\u0000-\u001f]/.test(path)) return false;

  // 除 Windows 盘符 `C:\` / `C:/` / `/C:/` 外不允许路径里出现冒号（排除 `git@github.com:org/repo`、`12:34:56` 等）
  const colonAt = path.indexOf(":");
  if (colonAt >= 0) {
    const winDrive = colonAt === 1 && /^[A-Za-z]:[\\/]/.test(path);
    const slashWinDrive = colonAt === 2 && /^\/[A-Za-z]:[\\/]/.test(path);
    if ((!winDrive && !slashWinDrive) || path.indexOf(":", colonAt + 1) >= 0) {
      return false;
    }
  }

  if (/^\/?[A-Za-z]:[\\/].+/.test(path)) return true;
  if (/^\\\\[^\\/\s]+[\\/].+/.test(path)) return true;
  if (/^\.\.?[\\/].+/.test(path)) return true;

  const base = path.split(/[\\/]/).pop() ?? "";
  if (!base || base === "." || base === "..") return false;

  if (path.startsWith("/")) {
    const parts = path.split("/").filter(Boolean);
    return parts.length >= 2 || hasFileExtension(base);
  }

  if (path.includes("/") || path.includes("\\")) {
    if (path.includes("//")) return false;
    const parts = path.split(/[\\/]/);
    if (parts.some((part) => part.length === 0)) return false;
    // 排除纯数字日期/比值如 `2026/11/19`、`10/20`
    if (!/[A-Za-z_\u4e00-\u9fff]/.test(path)) return false;
    // 排除两段式无扩展名 npm 包名如 `@xterm/xterm`
    if (path.startsWith("@") && parts.length === 2 && !hasFileExtension(base)) return false;
    return true;
  }

  return hasFileExtension(base);
}

function hasFileExtension(name: string): boolean {
  if (/^\.[A-Za-z][A-Za-z0-9._-]{1,30}$/.test(name)) return true;
  const match = /^(.+)\.([A-Za-z][A-Za-z0-9_-]{0,11})$/.exec(name);
  if (!match) return false;
  const stem = match[1]!;
  // 排除 `12.5ms`、`3.2s`、`v0.2.96`、`e.g`、`i.e`
  if (/^\d+$/.test(stem) || /^v?\d+(?:\.\d+)+$/i.test(stem)) return false;
  if (/^(?:e\.g|i\.e|etc|vs)$/i.test(name)) return false;
  return true;
}

function positiveInt(raw: string | undefined): number | null {
  if (!raw) return null;
  const num = Number(raw);
  return Number.isInteger(num) && num >= 1 ? num : null;
}

export interface FileLinkVerifier {
  peek(path: string): { known: true; resolved: string | null } | { known: false };
  verifyNow(path: string): Promise<string | null>;
  scheduleHover(path: string, onVerified: (resolved: string | null) => void): () => void;
  clear(): void;
}

/**
 * 终端文件路径悬浮校验器：悬浮满 250ms 才向 daemon 发 `files.resolve`，带正负结果缓存与并发去重。
 */
export function createFileLinkVerifier(
  resolveFile: ((path: string) => Promise<string | null>) | undefined,
  options?: {
    hoverDelayMs?: number;
    now?: () => number;
  },
): FileLinkVerifier {
  const hoverDelayMs = options?.hoverDelayMs ?? DEFAULT_HOVER_VERIFY_DELAY_MS;
  const now = options?.now ?? Date.now;
  const cache = new Map<string, { resolved: string | null; expiresAt: number }>();
  const inflight = new Map<string, Promise<string | null>>();

  const peek = (path: string): { known: true; resolved: string | null } | { known: false } => {
    const key = path.trim();
    if (!key) return { known: true, resolved: null };
    if (!resolveFile) return { known: true, resolved: key };
    const hit = cache.get(key);
    if (!hit) return { known: false };
    if (now() > hit.expiresAt) {
      cache.delete(key);
      return { known: false };
    }
    return { known: true, resolved: hit.resolved };
  };

  const verifyNow = (path: string): Promise<string | null> => {
    const key = path.trim();
    if (!key) return Promise.resolve(null);
    if (!resolveFile) return Promise.resolve(key);
    const cached = peek(key);
    if (cached.known) return Promise.resolve(cached.resolved);

    const existing = inflight.get(key);
    if (existing) return existing;

    const request = resolveFile(key)
      .then(
        (resolved) => {
          const clean = resolved?.trim() || null;
          cache.set(key, {
            resolved: clean,
            expiresAt: now() + (clean ? POSITIVE_CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS),
          });
          return clean;
        },
        () => {
          cache.set(key, { resolved: null, expiresAt: now() + NEGATIVE_CACHE_TTL_MS });
          return null;
        },
      )
      .finally(() => {
        inflight.delete(key);
      });
    inflight.set(key, request);
    return request;
  };

  const scheduleHover = (path: string, onVerified: (resolved: string | null) => void): (() => void) => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cached = peek(path);
    if (cached.known) {
      // 延后到微任务，避免在 xterm 初始化 reactive decorations 之前同步写被覆盖。
      queueMicrotask(() => {
        if (active) onVerified(cached.resolved);
      });
      return () => {
        active = false;
      };
    }

    timer = setTimeout(() => {
      timer = null;
      void verifyNow(path).then((resolved) => {
        if (active) onVerified(resolved);
      });
    }, hoverDelayMs);

    return () => {
      active = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
  };

  return {
    peek,
    verifyNow,
    scheduleHover,
    clear: () => {
      cache.clear();
      inflight.clear();
    },
  };
}

export interface TerminalLinkActions {
  openLocalUrl: (url: string) => void;
  openExternalUrl: (url: string) => void;
  openFile: (resolvedPath: string, line: number | null) => void;
  isMac?: boolean;
}

/** 构造注册给 `term.registerLinkProvider(...)` 的链接提供器。 */
export function createTerminalLinkProvider(
  getSource: () => { buffer: TerminalBufferLike; cols: number } | null,
  verifier: FileLinkVerifier,
  actions: TerminalLinkActions,
): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      const source = getSource();
      if (!source) {
        callback(undefined);
        return;
      }
      const parsed = detectLinksForBufferLine(source.buffer, source.cols, bufferLineNumber);
      if (parsed.length === 0) {
        callback(undefined);
        return;
      }

      const links: ILink[] = parsed.map((entry) => {
        if (entry.kind === "url") {
          return {
            range: entry.range,
            text: entry.text,
            decorations: { pointerCursor: true, underline: true },
            activate(event) {
              if (!isTerminalLinkTrigger(event, actions.isMac)) return;
              if (entry.local) actions.openLocalUrl(entry.url);
              else actions.openExternalUrl(entry.url);
            },
          };
        }

        const cached = verifier.peek(entry.path);
        const initialVerified = cached.known && cached.resolved !== null;
        let cancelHover: (() => void) | null = null;

        const link: ILink = {
          range: entry.range,
          text: entry.text,
          decorations: {
            pointerCursor: initialVerified,
            underline: initialVerified,
          },
          hover() {
            cancelHover?.();
            cancelHover = verifier.scheduleHover(entry.path, (resolved) => {
              const ok = resolved !== null;
              if (link.decorations) {
                link.decorations.pointerCursor = ok;
                link.decorations.underline = ok;
              }
            });
          },
          leave() {
            cancelHover?.();
            cancelHover = null;
          },
          dispose() {
            cancelHover?.();
            cancelHover = null;
          },
          activate(event) {
            if (!isTerminalLinkTrigger(event, actions.isMac)) return;
            void verifier.verifyNow(entry.path).then((resolved) => {
              if (resolved) actions.openFile(resolved, entry.line);
            });
          },
        };
        return link;
      });

      callback(links);
    },
  };
}

/** OSC 8 超链接（`\x1b]8;;...\x07`）处理器：同样遵守 Ctrl/Cmd+Click、内外网分流与文件存在校验。 */
export function createOscLinkHandler(verifier: FileLinkVerifier, actions: TerminalLinkActions) {
  return {
    allowNonHttpProtocols: true,
    activate(event: MouseEvent, uri: string) {
      if (!isTerminalLinkTrigger(event, actions.isMac)) return;
      const trimmed = uri.trim();
      if (/^https?:\/\//i.test(trimmed)) {
        if (isLocalOrIntranetUrl(trimmed)) actions.openLocalUrl(trimmed);
        else actions.openExternalUrl(trimmed);
        return;
      }
      if (/^file:\/\//i.test(trimmed)) {
        const parsed = parseFileUrlCandidate(trimmed);
        if (!parsed) return;
        void verifier.verifyNow(parsed.path).then((resolved) => {
          if (resolved) actions.openFile(resolved, parsed.line);
        });
      }
    },
  };
}
