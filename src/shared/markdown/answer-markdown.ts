// 助手回答的阅读排版。只影响展示，不改模型原文。
// 长的本机路径缩短显示，完整路径留在 title。
// 目录清单、代码入口和大表默认收起。

import { classifyImageTarget, type ImageSource } from "./markdown-images.ts";

export type Align = "left" | "center" | "right";

export type CollapseKind = "directory" | "files" | "table";

export type CollapseMeta = {
  kind: CollapseKind;
  count: number;
  detail: string;
  fallback: string;
};

export type Inline =
  | { type: "text"; text: string }
  | { type: "break" }
  | { type: "strong"; inlines: Inline[] }
  | { type: "em"; inlines: Inline[] }
  | { type: "code"; text: string; display?: string; title?: string }
  | { type: "link"; inlines: Inline[]; href: string; title?: string }
  | { type: "path"; display: string; full: string }
  | { type: "image"; alt: string; source: ImageSource };

export type AnswerBlock =
  | { type: "heading"; level: 1 | 2 | 3; inlines: Inline[] }
  | { type: "paragraph"; inlines: Inline[] }
  | { type: "list"; ordered: boolean; items: Inline[][]; meta: CollapseMeta | null }
  | {
      type: "table";
      header: Inline[][];
      aligns: Align[];
      rows: Inline[][][];
      meta: CollapseMeta | null;
    }
  | { type: "code"; lang: string; text: string; meta: CollapseMeta | null }
  | { type: "quote"; inlines: Inline[] }
  | { type: "rule" }
  | { type: "image"; alt: string; source: ImageSource }
  | { type: "section"; title: Inline[]; meta: CollapseMeta; body: AnswerBlock };

const CODE_EXT =
  "cs|ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|cpp|cc|cxx|c|h|hpp|hh|lua|json|xml|yml|yaml|toml|shader|hlsl|uxml|uss|asmdef|vue|rb|php|swift|mm|csproj|sln|html|css|scss";
const CODE_FILE = new RegExp(`^[\\w.+@-]+\\.(?:${CODE_EXT})$`, "i");
const CODE_FILE_IN = new RegExp(`[\\w.+@-]+\\.(?:${CODE_EXT})\\b`, "i");

const TEXT_PATH =
  /[A-Za-z]:[\\/][^\s<>"'`|*?()[\]{}，。；、]+|\\\\[^\s<>"'`|*?()[\]{}，。；、]+|\/(?:Users|home|opt|var|tmp|usr|private|Volumes)\/[^\s<>"'`|*?()[\]{}，。；、]+|(?:[\w.+@-]+[\\/]){5,}[\w.+@-]+/g;

const TABLE_MIN_ROWS = 6;
const FILE_LIST_MIN = 3;
const DIR_LIST_MIN = 6;
const DIR_CODE_MIN = 8;

export function parseAnswer(input: string): AnswerBlock[] {
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
  return attachSections(blocks);
}

/** 长本机路径的展示名。不够长、或不是路径时返回 null。 */
export function shortenLocalPath(raw: string): string | null {
  const path = raw.trim();
  if (!isLocalPath(path)) return null;
  const parts = pathSegments(path);
  const absolute = isAbsoluteLocal(path);
  const long = absolute ? parts.length >= 4 || path.length >= 48 : parts.length >= 6 || path.length >= 72;
  if (!long) return null;
  const file = parts[parts.length - 1];
  const parent = parts[parts.length - 2];
  if (!file) return null;
  if (!parent || parent.endsWith(":")) return `…/${file}`;
  return `…/${parent}/${file}`;
}

export function codeDisplayLines(text: string): Inline[][] {
  if (!text) return [];
  return text.split("\n").map((line) => splitTextPaths(line));
}

export function inlinePlain(inlines: Inline[]): string {
  let text = "";
  for (const node of inlines) {
    switch (node.type) {
      case "text":
      case "path":
        text += node.type === "path" ? node.full : node.text;
        break;
      case "break":
        text += "\n";
        break;
      case "code":
        text += node.text;
        break;
      case "strong":
      case "em":
      case "link":
        text += inlinePlain(node.inlines);
        break;
      case "image":
        text += node.alt;
        break;
      default:
        break;
    }
  }
  return text;
}

function attachSections(blocks: AnswerBlock[]): AnswerBlock[] {
  const tagged = blocks.map(applyMeta);
  const out: AnswerBlock[] = [];
  for (let i = 0; i < tagged.length; i += 1) {
    const block = tagged[i];
    const next = tagged[i + 1];
    if (block.type === "heading" && next && collapseOf(next)) {
      out.push({
        type: "section",
        title: block.inlines,
        meta: collapseOf(next) as CollapseMeta,
        body: clearMeta(next),
      });
      i += 1;
      continue;
    }
    out.push(block);
  }
  return out;
}

function applyMeta(block: AnswerBlock): AnswerBlock {
  const meta = collapseMeta(block);
  if (!meta) return block;
  if (block.type === "list" || block.type === "table" || block.type === "code") {
    return { ...block, meta };
  }
  return block;
}

function clearMeta(block: AnswerBlock): AnswerBlock {
  if (block.type === "list" || block.type === "table" || block.type === "code") {
    return { ...block, meta: null };
  }
  return block;
}

function collapseOf(block: AnswerBlock): CollapseMeta | null {
  if (block.type === "list" || block.type === "table" || block.type === "code") return block.meta;
  return null;
}

function collapseMeta(block: AnswerBlock): CollapseMeta | null {
  if (block.type === "table" && block.rows.length >= TABLE_MIN_ROWS) {
    return meta("table", block.rows.length, `${block.rows.length} 行`, "表格");
  }
  if (block.type === "list" && isFileList(block.items)) {
    return meta("files", block.items.length, `${block.items.length} 个文件`, "代码入口");
  }
  if (block.type === "list" && isDirectoryList(block.items)) {
    return meta("directory", block.items.length, `${block.items.length} 项`, "目录");
  }
  if (block.type === "code" && isDirectoryCode(block.text)) {
    const count = block.text.split("\n").filter((line) => line.trim()).length;
    return meta("directory", count, `${count} 项`, "目录");
  }
  return null;
}

function meta(kind: CollapseKind, count: number, detail: string, fallback: string): CollapseMeta {
  return { kind, count, detail, fallback };
}

function isFileList(items: Inline[][]): boolean {
  if (items.length < FILE_LIST_MIN) return false;
  const hits = items.filter(isFileItem).length;
  return hits / items.length >= 0.75;
}

function isFileItem(inlines: Inline[]): boolean {
  const plain = inlinePlain(inlines).trim();
  const hrefs = collectHrefs(inlines);
  const first = firstContent(inlines);
  const leading =
    (first?.type === "link" &&
      (startsWithCodeFile(inlinePlain(first.inlines)) ||
        hrefs.some((href) => CODE_FILE_IN.test(href)))) ||
    (first?.type === "code" && startsWithCodeFile(first.text)) ||
    (first?.type === "path" && CODE_FILE_IN.test(first.full)) ||
    ((first?.type === "text" || first?.type === "strong") && startsWithCodeFile(plain));
  if (!leading) return false;
  const hasPath = hrefs.some((href) => isLocalPath(href)) || inlines.some((node) => node.type === "path");
  return hasPath || /[：:]/.test(plain);
}

function startsWithCodeFile(plain: string): boolean {
  const token = plain
    .trim()
    .replace(/^[`[]+/, "")
    .split(/[\s：:(]/)[0]
    ?.replace(/[\]`]+$/, "");
  return !!token && CODE_FILE.test(token);
}

function isDirectoryList(items: Inline[][]): boolean {
  if (items.length < DIR_LIST_MIN) return false;
  const hits = items.filter(isDirectoryItem).length;
  return hits / items.length >= 0.8;
}

function isDirectoryItem(inlines: Inline[]): boolean {
  const plain = inlinePlain(inlines).trim();
  if (!plain || plain.length > 180) return false;
  const head = plain.split(/[：:]/)[0]?.trim().replace(/^`+|`+$/g, "") ?? "";
  if (!head || head.length < plain.length * 0.6) return false;
  if (/\s/.test(head) && !isAbsoluteLocal(head)) return false;
  return isPathLike(head);
}

function isDirectoryCode(text: string): boolean {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length < DIR_CODE_MIN) return false;
  const hits = lines.filter(isListingLine).length;
  return hits / lines.length >= 0.7;
}

function isListingLine(line: string): boolean {
  const trimmed = line.trim();
  const structural = /[│├└┤┬┼─]/.test(trimmed);
  const payload = trimmed.replace(/^[-|\s`\\+─│├└┤┬┼]+/, "").trim();
  if (structural && payload.length > 0) return true;
  if (!payload) return structural;
  if (isPathLike(payload) || isAbsoluteLocal(payload)) return true;
  if (/\/$/.test(payload)) return true;
  return CODE_FILE.test(payload) && !/\s/.test(payload);
}

function isPathLike(text: string): boolean {
  if (isAbsoluteLocal(text)) return pathSegments(text).length >= 2;
  return /^(?:[\w.+@-]+[\\/]){2,}[\w.+@-]+\/?$/.test(text);
}

function firstContent(inlines: Inline[]): Inline | undefined {
  return inlines.find((node) => node.type !== "break" && !(node.type === "text" && node.text.trim() === ""));
}

function collectHrefs(inlines: Inline[]): string[] {
  const hrefs: string[] = [];
  for (const node of inlines) {
    if (node.type === "link") {
      hrefs.push(node.href);
      hrefs.push(...collectHrefs(node.inlines));
    } else if (node.type === "strong" || node.type === "em") {
      hrefs.push(...collectHrefs(node.inlines));
    }
  }
  return hrefs;
}

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

function parseInlines(input: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  let i = 0;
  const flush = () => {
    if (!text) return;
    out.push(...splitTextPaths(text));
    text = "";
  };

  while (i < input.length) {
    if (input[i] === "\\" && i + 1 < input.length) {
      text += input[i + 1];
      i += 2;
      continue;
    }
    if (input[i] === "\n") {
      flush();
      out.push({ type: "break" });
      i += 1;
      continue;
    }

    const code = readCodeSpan(input, i);
    if (code) {
      flush();
      out.push(codeInline(code.text));
      i = code.end;
      continue;
    }

    const image = readImage(input, i);
    if (image) {
      flush();
      if (image.source) out.push({ type: "image", alt: image.alt, source: image.source });
      else out.push({ type: "text", text: input.slice(i, image.end) });
      i = image.end;
      continue;
    }

    const link = readLink(input, i);
    if (link) {
      flush();
      out.push(link.node);
      i = link.end;
      continue;
    }

    const strong = readWrapped(input, i, input.startsWith("__", i) ? "__" : "**");
    if (strong && (input.startsWith("**", i) || input.startsWith("__", i))) {
      flush();
      out.push({ type: "strong", inlines: strong.inlines });
      i = strong.end;
      continue;
    }

    const em = readEmphasis(input, i);
    if (em) {
      flush();
      out.push({ type: "em", inlines: em.inlines });
      i = em.end;
      continue;
    }

    text += input[i];
    i += 1;
  }
  flush();
  return out;
}

function codeInline(text: string): Inline {
  const display = shortenLocalPath(text);
  if (!display) return { type: "code", text };
  return { type: "code", text, display, title: text };
}

function readCodeSpan(input: string, index: number): { text: string; end: number } | null {
  if (input[index] !== "`") return null;
  let size = 0;
  while (input[index + size] === "`") size += 1;
  const closer = "`".repeat(size);
  const end = input.indexOf(closer, index + size);
  if (end < 0) return null;
  let text = input.slice(index + size, end);
  if (text.length >= 2 && text.startsWith(" ") && text.endsWith(" ") && text.trim() !== "") {
    text = text.slice(1, -1);
  }
  return { text, end: end + size };
}

function readImage(
  input: string,
  index: number,
): { alt: string; source: ImageSource | null; end: number } | null {
  if (!input.startsWith("![", index)) return null;
  let cursor = index + 2;
  const altStart = cursor;
  while (cursor < input.length && input[cursor] !== "]" && input[cursor] !== "\n") cursor += 1;
  if (input[cursor] !== "]" || input[cursor + 1] !== "(") return null;
  const alt = input.slice(altStart, cursor);
  const dest = readDestination(input, cursor + 1);
  if (!dest) return null;
  return { alt, source: classifyImageTarget(dest.dest), end: dest.end };
}

function readLink(input: string, index: number): { node: Extract<Inline, { type: "link" }>; end: number } | null {
  if (input[index] !== "[") return null;
  let cursor = index + 1;
  while (cursor < input.length && input[cursor] !== "]" && input[cursor] !== "\n") cursor += 1;
  if (input[cursor] !== "]" || input[cursor + 1] !== "(") return null;
  const dest = readDestination(input, cursor + 1);
  if (!dest || !dest.dest) return null;
  const label = input.slice(index + 1, cursor);
  const href = dest.dest;
  return {
    node: {
      type: "link",
      inlines: parseInlines(label),
      href,
      title: shortenLocalPath(href) ? href : undefined,
    },
    end: dest.end,
  };
}

function readDestination(input: string, open: number): { dest: string; end: number } | null {
  if (input[open] !== "(") return null;
  let i = open + 1;
  while (input[i] === " " || input[i] === "\t") i += 1;
  if (input[i] === "<") {
    const close = input.indexOf(">", i + 1);
    if (close < 0 || input.slice(i + 1, close).includes("\n")) return null;
    const dest = input.slice(i + 1, close).trim();
    let after = close + 1;
    while (input[after] === " " || input[after] === "\t") after += 1;
    if (input[after] === '"' || input[after] === "'") {
      const quote = input[after];
      const quoteEnd = input.indexOf(quote, after + 1);
      if (quoteEnd < 0) return null;
      after = quoteEnd + 1;
    }
    while (input[after] === " " || input[after] === "\t") after += 1;
    if (input[after] !== ")") return null;
    return { dest, end: after + 1 };
  }
  const close = indexOfClosingParen(input, open);
  if (close < 0 || input.slice(open, close).includes("\n")) return null;
  return { dest: stripTitle(input.slice(i, close)), end: close + 1 };
}

function indexOfClosingParen(input: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function stripTitle(dest: string): string {
  return dest.replace(/\s+["'](?:\\.|[^"'])*["']\s*$/, "").trim();
}

function readWrapped(
  input: string,
  index: number,
  marker: "**" | "__",
): { inlines: Inline[]; end: number } | null {
  if (!input.startsWith(marker, index)) return null;
  if (marker === "__" && isWord(input[index - 1])) return null;
  const start = index + marker.length;
  if (!input[start] || /\s/.test(input[start])) return null;
  const close = indexOfMarker(input, start, marker);
  if (close < 0) return null;
  if (marker === "__" && isWord(input[close + marker.length])) return null;
  const inner = input.slice(start, close);
  if (!inner.trim()) return null;
  return { inlines: parseInlines(inner), end: close + marker.length };
}

function readEmphasis(input: string, index: number): { inlines: Inline[]; end: number } | null {
  // 单下划线不当地把 snake_case、ai_{id} 收成斜体，只认 *斜体*。
  if (input[index] !== "*" || input[index + 1] === "*") return null;
  if (!input[index + 1] || /\s/.test(input[index + 1])) return null;
  const close = indexOfMarker(input, index + 1, "*");
  if (close < 0) return null;
  const inner = input.slice(index + 1, close);
  if (!inner.trim()) return null;
  return { inlines: parseInlines(inner), end: close + 1 };
}

function indexOfMarker(input: string, from: number, marker: string): number {
  for (let i = from; i < input.length; i += 1) {
    if (input[i] === "\\") {
      i += 1;
      continue;
    }
    if (input[i] === "`") {
      const code = readCodeSpan(input, i);
      if (code) {
        i = code.end - 1;
        continue;
      }
    }
    if (!input.startsWith(marker, i)) continue;
    if (marker.length === 1 && input[i + 1] === marker) continue;
    if (marker === "_" && isWord(input[i + 1])) continue;
    if (/\s/.test(input[i - 1] ?? "")) continue;
    return i;
  }
  return -1;
}

function isWord(ch: string | undefined): boolean {
  return !!ch && /[\w\u4e00-\u9fff]/.test(ch);
}

function splitTextPaths(text: string): Inline[] {
  if (!text) return [];
  const out: Inline[] = [];
  const re = new RegExp(TEXT_PATH.source, "g");
  let last = 0;
  for (const match of text.matchAll(re)) {
    const start = match.index ?? 0;
    if (start < last) continue;
    const prev = start > 0 ? text[start - 1] : "";
    if (prev && (/[\w/]/.test(prev) || (prev === ":" && text[start - 2] === "/"))) continue;
    const raw = match[0].replace(/[.,;:]+$/g, "");
    const display = raw ? shortenLocalPath(raw) : null;
    if (!display) continue;
    if (start > last) out.push({ type: "text", text: text.slice(last, start) });
    out.push({ type: "path", display, full: raw });
    last = start + raw.length;
  }
  if (last < text.length) out.push({ type: "text", text: text.slice(last) });
  return out.length > 0 ? out : [{ type: "text", text }];
}

function isLocalPath(path: string): boolean {
  return isAbsoluteLocal(path) || isRelativePath(path);
}

function isAbsoluteLocal(path: string): boolean {
  return (
    /^[A-Za-z]:[\\/]/.test(path) ||
    /^\\\\[^\\]+\\/.test(path) ||
    /^\/(?:Users|home|opt|var|tmp|usr|private|Volumes)\//.test(path)
  );
}

function isRelativePath(path: string): boolean {
  if (/[\s"'`<>|*?]/.test(path) || path.includes("://")) return false;
  return /^(?:[\w.+@-]+[\\/]){2,}[\w.+@-]+$/.test(path);
}

function pathSegments(path: string): string[] {
  return path.replace(/\\/g, "/").split("/").filter(Boolean);
}
