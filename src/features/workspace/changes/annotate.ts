import type { PageAnnotation } from "@/types";

/** 标签标题只用 document.title。不裁掉页面自己写上的数字。 */
export function tabTitleFromDocument(title: string): string {
  return title.replace(/^\s+|\s+$/g, "");
}

/** Codex `commentAttachments.numAnnotations`：one/other 都是「N 条注释」。 */
export function annotationCountLabel(count: number): string {
  return `${count} 条注释`;
}

export function annotationLabel(note: PageAnnotation): string {
  if (note.kind === "region") return "区域";
  const text = note.text.trim();
  if (text) return clip(text);
  const selector = note.selector.trim();
  if (selector) return clip(selector);
  return "元素";
}

function clip(text: string): string {
  return text.length > 24 ? `${text.slice(0, 24)}…` : text;
}

/** 与适配层 `fold_page_annotations` 同一段正文，供非 Tauri 预览。 */
export function foldPageAnnotations(
  text: string,
  notes: PageAnnotation[],
): { text: string; images: string[] } {
  if (notes.length === 0) return { text, images: [] };
  const images: string[] = [];
  const blocks = notes.map((note, index) => {
    const lines = [`页面批注 ${index + 1}`];
    const comment = note.comment.trim();
    if (comment) lines.push(`评论：${comment}`);
    const url = note.url.trim();
    if (url) lines.push(`页面：${url}`);
    const selector = note.selector.trim();
    if (selector) lines.push(`选择器：${selector}`);
    const element = note.text.trim();
    if (element) lines.push(`元素文本：${element.slice(0, 500)}`);
    lines.push(`区域：${note.x},${note.y} ${note.width}×${note.height}`);
    const shot = note.screenshot?.trim() ?? "";
    if (shot) {
      lines.push("附图为该区域所在页面的截图。");
      if (!images.includes(shot)) images.push(shot);
    }
    return lines.join("\n");
  });
  const extra = blocks.join("\n\n");
  return { text: text.trim() ? `${text}\n\n${extra}` : extra, images };
}
