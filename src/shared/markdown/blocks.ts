// 块状态机。行内节点交给 `parseInlines`，不在这里展开。

import type { Align, AnswerBlock, Inline } from "./ast.ts";
import { parseInlines } from "./inline.ts";

function tryParseFence(lines: string[], index: number): { block: AnswerBlock; next: number } | null {
  const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(lines[index]);
  if (!match) return null;
  if (match[2][0] === "`" && match[3].includes("`")) return null;
  const marker = match[2][0];
  const size = match[2].length;
  const lang = match[3].trim();
  const body: string[] = [];
  let i = index + 1;
  const closer = new RegExp(`^ {0,3}${marker === "`" ? "`" : "~"}{${size},}\\s*$`);
  while (i < lines.length && !closer.test(lines[i])) {
    body.push(lines[i]);
    i += 1;
  }
  if (i < lines.length) i += 1;
  return { block: { type: "code", lang, text: body.join("\n"), meta: null }, next: i };
}

function tryParseHeading(lines: string[], index: number): { block: AnswerBlock; next: number } | null {
  const match = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[index]);
  if (!match) return null;
  const level = Math.min(match[1].length, 3) as 1 | 2 | 3;
  return { block: { type: "heading", level, inlines: parseInlines(match[2].trim()) }, next: index + 1 };
}

function tryParseRule(lines: string[], index: number): { block: AnswerBlock; next: number } | null {
  if (!/^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(lines[index])) return null;
  return { block: { type: "rule" }, next: index + 1 };
}

function tryParseTable(lines: string[], index: number): { block: AnswerBlock; next: number } | null {
  if (!isTableStart(lines, index)) return null;
  const header = splitTableRow(lines[index]);
  const separator = splitTableRow(lines[index + 1]);
  if (!header || !separator) return null;
  const columns = header.length;
  const aligns = separator.map(parseAlign);
  const rows: Inline[][][] = [];
  let i = index + 2;
  while (i < lines.length && lines[i].trim() !== "" && looksLikeRow(lines[i], columns) && !isSeparatorLine(lines[i])) {
    rows.push(normalizeCells(splitTableRow(lines[i]) ?? [], columns).map((cell) => parseInlines(cell)));
    i += 1;
  }
  return {
    block: {
      type: "table",
      header: header.map((cell) => parseInlines(cell)),
      aligns,
      rows,
      meta: null,
    },
    next: i,
  };
}

function tryParseList(lines: string[], index: number): { block: AnswerBlock; next: number } | null {
  const first = matchListItem(lines[index]);
  if (!first) return null;
  const ordered = first.ordered;
  const items: Inline[][] = [];
  let i = index;
  while (i < lines.length) {
    if (lines[i].trim() === "") break;
    const item = matchListItem(lines[i]);
    if (!item || item.ordered !== ordered) break;
    const parts = [item.text];
    i += 1;
    while (i < lines.length && isContinuation(lines, i)) {
      parts.push(lines[i].trim());
      i += 1;
    }
    items.push(parseInlines(parts.join("\n")));
  }
  if (items.length === 0) return null;
  return { block: { type: "list", ordered, items, meta: null }, next: i };
}

function tryParseQuote(lines: string[], index: number): { block: AnswerBlock; next: number } | null {
  if (!/^ {0,3}>/.test(lines[index])) return null;
  const parts: string[] = [];
  let i = index;
  while (i < lines.length && /^ {0,3}>/.test(lines[i])) {
    parts.push(lines[i].replace(/^ {0,3}>\s?/, ""));
    i += 1;
  }
  return { block: { type: "quote", inlines: parseInlines(parts.join("\n")) }, next: i };
}

function tryParseBoldHeading(lines: string[], index: number): { block: AnswerBlock; next: number } | null {
  const inner = boldHeadingInner(lines[index]);
  if (inner === null) return null;
  const next = lines[index + 1];
  if (next !== undefined && next.trim() !== "" && !isBlockStart(lines, index + 1)) return null;
  return { block: { type: "heading", level: 2, inlines: parseInlines(inner) }, next: index + 1 };
}

function tryParseParagraph(lines: string[], index: number): { block: AnswerBlock; next: number } {
  const parts = [lines[index]];
  let i = index + 1;
  while (i < lines.length && lines[i].trim() !== "" && !isBlockStart(lines, i)) {
    parts.push(lines[i]);
    i += 1;
  }
  const inlines = parseInlines(parts.join("\n"));
  if (isLoneImage(inlines)) {
    const image = inlines.find((node) => node.type === "image");
    if (image && image.type === "image") {
      return { block: { type: "image", alt: image.alt, source: image.source }, next: i };
    }
  }
  return { block: { type: "paragraph", inlines }, next: i };
}

function isBlockStart(lines: string[], index: number): boolean {
  const line = lines[index];
  if (line === undefined) return false;
  if (/^(?: {0,3})(`{3,}|~{3,})/.test(line)) return true;
  if (/^ {0,3}#{1,6}\s+\S/.test(line)) return true;
  if (/^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) return true;
  if (/^ {0,3}[-*+]\s+\S/.test(line)) return true;
  if (/^ {0,3}\d{1,6}[.)]\s+\S/.test(line)) return true;
  if (/^ {0,3}>/.test(line)) return true;
  return isTableStart(lines, index);
}

function isContinuation(lines: string[], index: number): boolean {
  return /^ {2,}\S/.test(lines[index] ?? "") && !isBlockStart(lines, index);
}

function matchListItem(line: string): { ordered: boolean; text: string } | null {
  const ordered = /^ {0,3}\d{1,6}[.)]\s+(.*)$/.exec(line);
  if (ordered && ordered[1].trim()) return { ordered: true, text: ordered[1] };
  const bullet = /^ {0,3}[-*+]\s+(.*)$/.exec(line);
  if (bullet && bullet[1].trim()) return { ordered: false, text: bullet[1] };
  return null;
}

function boldHeadingInner(line: string): string | null {
  const match = /^\s*(?:\*\*|__)(.+?)(?:\*\*|__)\s*$/.exec(line);
  if (!match) return null;
  const text = match[1].trim();
  if (!text || text.length > 40) return null;
  if (/[。！？!?]/.test(text)) return null;
  if (text.includes("**") || text.includes("__")) return null;
  return text;
}

function isTableStart(lines: string[], index: number): boolean {
  const header = splitTableRow(lines[index] ?? "");
  if (!header || header.length < 2) return false;
  return isSeparatorLine(lines[index + 1] ?? "");
}

function isSeparatorLine(line: string): boolean {
  const cells = splitTableRow(line);
  if (!cells || cells.length < 2) return false;
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function looksLikeRow(line: string, columns: number): boolean {
  const cells = splitTableRow(line);
  if (!cells) return false;
  if (line.trim().startsWith("|")) return true;
  return cells.length === columns;
}

function splitTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return null;
  let body = trimmed;
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|")) body = body.slice(0, -1);
  const cells: string[] = [];
  let current = "";
  let code = false;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === "`") {
      code = !code;
      current += ch;
      continue;
    }
    if (ch === "|" && !code) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells.length > 0 ? cells : null;
}

function normalizeCells(cells: string[], columns: number): string[] {
  const next = cells.slice(0, columns);
  while (next.length < columns) next.push("");
  return next;
}

function parseAlign(cell: string): Align {
  const text = cell.trim();
  const left = text.startsWith(":");
  const right = text.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  return "left";
}

function isLoneImage(inlines: Inline[]): boolean {
  const content = inlines.filter((node) => node.type !== "break" && !(node.type === "text" && node.text.trim() === ""));
  return content.length === 1 && content[0].type === "image";
}

export function parseBlocks(input: string): AnswerBlock[] {
  const lines = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const blocks: AnswerBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === "") {
      i += 1;
      continue;
    }
    const parsed =
      tryParseFence(lines, i) ??
      tryParseHeading(lines, i) ??
      tryParseRule(lines, i) ??
      tryParseTable(lines, i) ??
      tryParseList(lines, i) ??
      tryParseQuote(lines, i) ??
      tryParseBoldHeading(lines, i) ??
      tryParseParagraph(lines, i);
    blocks.push(parsed.block);
    i = parsed.next;
  }
  return blocks;
}
