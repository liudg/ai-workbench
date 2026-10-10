// 聊天时间线只渲染 Markdown 图片，其余文本保持原样。
// 远程只接受 https。本机只接受绝对路径，且扩展名必须是图片。

export type ImageSource =
  | { type: "https"; url: string }
  | { type: "local"; path: string };

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "image"; alt: string; source: ImageSource };

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "avif",
]);

export function parseMessageContent(input: string): MessagePart[] {
  const parts: MessagePart[] = [];
  let text = "";
  const flush = () => {
    if (!text) return;
    parts.push({ type: "text", text });
    text = "";
  };

  let i = 0;
  while (i < input.length) {
    const fenceEnd = consumeFence(input, i);
    if (fenceEnd !== null) {
      text += input.slice(i, fenceEnd);
      i = fenceEnd;
      continue;
    }

    if (input[i] === "`") {
      const end = consumeInlineCode(input, i);
      text += input.slice(i, end);
      i = end;
      continue;
    }

    if (
      input.startsWith("![", i) &&
      (i === 0 || input[i - 1] !== "\\")
    ) {
      const image = tryParseImage(input, i);
      if (image) {
        flush();
        parts.push(image.part);
        i = image.end;
        continue;
      }
    }

    text += input[i];
    i += 1;
  }

  flush();
  return parts;
}

/** https 图片，或本机绝对图片路径。其它目标返回 null，调用方应保留原文。 */
export function classifyImageTarget(raw: string): ImageSource | null {
  const dest = raw.trim();
  if (!dest || /[\u0000-\u001f]/.test(dest)) return null;

  if (/^https:\/\//i.test(dest)) {
    const url = safeHttpsUrl(dest);
    return url ? { type: "https", url } : null;
  }

  const path = normalizeLocalImagePath(dest);
  return path ? { type: "local", path } : null;
}

export function normalizeLocalImagePath(raw: string): string | null {
  let path = raw.trim().replace(/^["']|["']$/g, "");
  if (/^file:/i.test(path)) {
    const converted = fileUrlToPath(path);
    if (!converted) return null;
    path = converted;
  }

  path = path.replace(/\//g, "\\");
  if (path.startsWith("\\\\")) {
    path = `\\\\${path.slice(2).replace(/\\{2,}/g, "\\")}`;
  } else {
    path = path.replace(/\\{2,}/g, "\\");
  }

  const drive = /^[A-Za-z]:\\/.test(path);
  const unc = /^\\\\[^\\]+\\[^\\]+/.test(path);
  const verbatim = /^\\\\\?\\[A-Za-z]:\\/.test(path);
  if (!drive && !unc && !verbatim) return null;
  if (path.split("\\").some((segment) => segment === "..")) return null;

  const base = path.slice(path.lastIndexOf("\\") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) return null;
  return path;
}

function safeHttpsUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (!url.hostname) return null;
  return url.href;
}

function fileUrlToPath(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "file:") return null;

  let pathname = decodeURIComponent(url.pathname);
  if (/^\/[A-Za-z]:[\\/]/.test(pathname)) {
    pathname = pathname.slice(1);
  }
  const host = url.hostname;
  if (host && host.toLowerCase() !== "localhost") {
    return `\\\\${host}${pathname}`;
  }
  return pathname;
}

function tryParseImage(
  input: string,
  start: number,
): { part: Extract<MessagePart, { type: "image" }>; end: number } | null {
  let cursor = start + 2;
  const altStart = cursor;
  while (cursor < input.length && input[cursor] !== "]" && input[cursor] !== "\n") {
    cursor += 1;
  }
  if (input[cursor] !== "]" || input[cursor + 1] !== "(") return null;
  const alt = input.slice(altStart, cursor);
  const open = cursor + 1;
  let destStart = open + 1;
  while (input[destStart] === " " || input[destStart] === "\t") destStart += 1;

  let dest = "";
  let end = -1;
  if (input[destStart] === "<") {
    const closeAngle = input.indexOf(">", destStart + 1);
    if (closeAngle < 0 || input.slice(destStart + 1, closeAngle).includes("\n")) {
      return null;
    }
    dest = input.slice(destStart + 1, closeAngle).trim();
    let after = closeAngle + 1;
    while (input[after] === " " || input[after] === "\t") after += 1;
    if (input[after] === '"' || input[after] === "'") {
      const quote = input[after];
      const quoteEnd = input.indexOf(quote, after + 1);
      if (quoteEnd < 0) return null;
      after = quoteEnd + 1;
      while (input[after] === " " || input[after] === "\t") after += 1;
    }
    if (input[after] !== ")") return null;
    end = after + 1;
  } else {
    const close = indexOfClosingParen(input, open);
    if (close < 0) return null;
    dest = stripMarkdownTitle(input.slice(destStart, close));
    end = close + 1;
  }

  const source = classifyImageTarget(dest);
  if (!source) return null;
  return { part: { type: "image", alt, source }, end };
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

function stripMarkdownTitle(dest: string): string {
  return dest.replace(/\s+["'](?:\\.|[^"'])*["']\s*$/, "").trim();
}

function consumeFence(input: string, index: number): number | null {
  if (index > 0 && input[index - 1] !== "\n") return null;
  const lineEnd = input.indexOf("\n", index);
  const line = lineEnd === -1 ? input.slice(index) : input.slice(index, lineEnd);
  const match = /^( {0,3})(`{3,}|~{3,})[^`]*$/.exec(line);
  if (!match) return null;
  const marker = match[2][0];
  const size = match[2].length;
  if (lineEnd === -1) return input.length;

  let pos = lineEnd + 1;
  const closer = new RegExp(`^ {0,3}${marker}{${size},}\\s*$`);
  while (pos <= input.length) {
    const nextEnd = input.indexOf("\n", pos);
    const nextLine = nextEnd === -1 ? input.slice(pos) : input.slice(pos, nextEnd);
    if (closer.test(nextLine)) {
      return nextEnd === -1 ? input.length : nextEnd + 1;
    }
    if (nextEnd === -1) return input.length;
    pos = nextEnd + 1;
  }
  return input.length;
}

function consumeInlineCode(input: string, index: number): number {
  let size = 0;
  while (input[index + size] === "`") size += 1;
  const closer = input.indexOf("`".repeat(size), index + size);
  if (closer < 0) return index + 1;
  return closer + size;
}
