/**
 * 用户气泡上的页面批注数量。
 * 展示文案是「N 条注释」。时间线只依赖这个类型，不引用 panel/browser。
 */
export interface AnnotationCount {
  count: number;
}

export function annotationCountOf(count: number | undefined): AnnotationCount | null {
  if (!count || count <= 0) return null;
  return { count };
}

export function annotationCountLabel(count: AnnotationCount["count"]): string {
  return `${count} 条注释`;
}
