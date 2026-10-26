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

/** 本机图片路径、data URL，或 http(s) 图片地址。 */
export function isImagePath(path: string): boolean {
  const trimmed = path.trim();
  if (!trimmed) return false;
  if (/^data:image\//i.test(trimmed)) return true;
  const clean = trimmed.split(/[?#]/)[0];
  if (/^https?:\/\//i.test(clean)) {
    return extensionOf(clean) !== null;
  }
  return extensionOf(clean) !== null;
}

function extensionOf(path: string): string | null {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext) ? ext : null;
}

export function fileName(path: string): string {
  const trimmed = path.trim();
  if (/^data:image\//i.test(trimmed)) return "图片";
  const clean = trimmed.split(/[?#]/)[0];
  return clean.split(/[\\/]/).filter(Boolean).pop() || "图片";
}
