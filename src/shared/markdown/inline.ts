// 行内状态机：代码、链接、图片、强调，以及正文里的本机路径。

import { classifyImageTarget, type ImageSource } from "./markdown-images.ts";
import type { Inline } from "./ast.ts";
import { shortenLocalPath, splitTextPaths } from "./paths.ts";

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

export function parseInlines(input: string): Inline[] {
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

export function codeInline(text: string): Inline {
  const display = shortenLocalPath(text);
  if (!display) return { type: "code", text };
  return { type: "code", text, display, title: text };
}

export function readCodeSpan(input: string, index: number): { text: string; end: number } | null {
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

export function readImage(
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

export function readLink(input: string, index: number): { node: Extract<Inline, { type: "link" }>; end: number } | null {
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

export function readDestination(input: string, open: number): { dest: string; end: number } | null {
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

export function indexOfClosingParen(input: string, openIndex: number): number {
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

export function stripTitle(dest: string): string {
  return dest.replace(/\s+["'](?:\\.|[^"'])*["']\s*$/, "").trim();
}

export function readWrapped(
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

export function readEmphasis(input: string, index: number): { inlines: Inline[]; end: number } | null {
  // 单下划线不当地把 snake_case、ai_{id} 收成斜体，只认 *斜体*。
  if (input[index] !== "*" || input[index + 1] === "*") return null;
  if (!input[index + 1] || /\s/.test(input[index + 1])) return null;
  const close = indexOfMarker(input, index + 1, "*");
  if (close < 0) return null;
  const inner = input.slice(index + 1, close);
  if (!inner.trim()) return null;
  return { inlines: parseInlines(inner), end: close + 1 };
}

export function indexOfMarker(input: string, from: number, marker: string): number {
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

export function isWord(ch: string | undefined): boolean {
  return !!ch && /[\w\u4e00-\u9fff]/.test(ch);
}
