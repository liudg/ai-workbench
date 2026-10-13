export function isFileHref(href: string): boolean {
  const raw = href.trim();
  if (!raw || /^(https?:|mailto:|data:|javascript:|#)/i.test(raw)) return false;
  if (/^file:/i.test(raw)) return true;
  if (/^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith("\\\\") || raw.startsWith("/")) return true;
  if (raw.startsWith("./") || raw.startsWith("../") || raw.includes("/") || raw.includes("\\")) {
    return true;
  }
  const name = raw.split(/[?#]/)[0] ?? raw;
  return /\.[A-Za-z0-9]{1,8}$/.test(name);
}

/** `annotate.html (line 12)` → 路径和行号。行号从 1 开始。 */
export function fileLineRef(label: string): { path: string; line: number } | null {
  const match = /^(.*\S)\s+\(line\s+(\d+)\)\s*$/i.exec(label.trim());
  if (!match) return null;
  const line = Number(match[2]);
  if (!Number.isInteger(line) || line < 1) return null;
  const path = match[1].trim();
  if (!path) return null;
  return { path, line };
}

export function lineFromHref(href: string): number | null {
  const hash = href.split("#")[1]?.split("&")[0] ?? "";
  const match = /^L(\d+)$/i.exec(hash);
  if (!match) return null;
  const line = Number(match[1]);
  return Number.isInteger(line) && line >= 1 ? line : null;
}

export function isHtmlHref(href: string): boolean {
  const bare = href.trim().split(/[?#]/)[0] ?? "";
  return /\.html?$/i.test(bare);
}
