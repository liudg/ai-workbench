/** 聊天里的文件链接。行号在打开前剥掉，磁盘上没有 `file.cs:648` 这种文件。 */

const HASH_LINE = /^#L(\d+)(?:C\d+)?(?:-L?\d+(?:C\d+)?)?(?:&[^?]*)?$/i;
const COLON_LOC = /:(\d+)(?::(\d+))?(?:-(\d+)(?::(\d+))?)?$/;

export type FileLocation = { path: string; line: number | null };

export function isFileHref(href: string): boolean {
  const raw = href.trim();
  if (!raw || /^(https?:|mailto:|data:|javascript:|#)/i.test(raw)) return false;
  const path = stripFileLocation(raw).path;
  if (!path || /^(https?:|mailto:|data:|javascript:|#)/i.test(path)) return false;
  if (/^file:/i.test(path)) return true;
  if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\") || path.startsWith("/")) return true;
  if (path.startsWith("./") || path.startsWith("../") || path.includes("/") || path.includes("\\")) {
    return true;
  }
  return /\.[A-Za-z0-9]{1,8}$/.test(path);
}

/**
 * `annotate.html (line 12)`、`LoginService.cs:648`、`LoginService.cs:648:12`、`#L648`。
 * 行号从 1 开始。没有行号时返回 null。
 */
export function fileLineRef(label: string): { path: string; line: number } | null {
  const match = /^(.*\S)\s+\(line\s+(\d+)\)\s*$/i.exec(label.trim());
  if (match) {
    const line = Number(match[2]);
    if (!Number.isInteger(line) || line < 1) return null;
    const path = match[1].trim();
    if (!path) return null;
    return { path, line };
  }
  const located = stripFileLocation(label);
  if (located.line == null || !located.path || !isFileHref(located.path)) return null;
  return { path: located.path, line: located.line };
}

export function lineFromHref(href: string): number | null {
  return stripFileLocation(href).line;
}

/**
 * 对齐 Codex：先去掉 `#L` / `#Lstart-Lend`，再去掉末尾的 `:line`、`:line:col` 和区间。
 * 盘符冒号后面是斜杠，不会被当成行号。
 */
export function stripFileLocation(input: string): FileLocation {
  let raw = unwrapAngles(input.trim());
  if (!raw) return { path: "", line: null };

  let line: number | null = null;
  const hashAt = raw.indexOf("#");
  if (hashAt >= 0) {
    const hash = (raw.slice(hashAt).split("?")[0] ?? "").trim();
    const hashLine = HASH_LINE.exec(hash);
    if (hashLine) line = positiveLine(hashLine[1]);
    raw = raw.slice(0, hashAt);
  }

  const queryAt = raw.indexOf("?");
  if (queryAt >= 0) raw = raw.slice(0, queryAt);
  raw = raw.trim();

  const colon = matchColonSuffix(raw);
  if (colon) {
    raw = colon.path;
    if (line == null) line = colon.line;
  }
  return { path: raw, line };
}

export function isHtmlHref(href: string): boolean {
  const bare = href.trim().split(/[?#]/)[0] ?? "";
  return /\.html?$/i.test(bare);
}

/** 行内代码中的单个 HTML 文件；命令、通配符和外链仍按代码展示。 */
export function inlineHtmlPath(text: string): string | null {
  const path = text.trim();
  if (!isHtmlHref(path) || !isFileHref(path)) return null;
  if (/[\r\n"'`<>|*]/.test(path)) return null;
  // 有空格时须明确以路径开头，避免把 `start index.html` 当成文件名。
  if (/\s/.test(path) && !/^(?:[A-Za-z]:[\\/]|file:\/|[\\/]|\.\.?[\\/])/i.test(path)) return null;
  return path;
}

function unwrapAngles(value: string): string {
  if (value.length >= 2 && value.startsWith("<") && value.endsWith(">")) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function matchColonSuffix(path: string): { path: string; line: number } | null {
  const match = COLON_LOC.exec(path);
  if (!match || match.index <= 0) return null;
  const line = positiveLine(match[1]);
  if (line == null) return null;
  const bare = path.slice(0, match.index);
  if (!bare || /[\\/]$/.test(bare)) return null;
  return { path: bare, line };
}

function positiveLine(raw: string | undefined): number | null {
  if (!raw) return null;
  const line = Number(raw);
  return Number.isInteger(line) && line >= 1 ? line : null;
}
