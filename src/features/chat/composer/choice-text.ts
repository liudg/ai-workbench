/** 选项标题里有汉字。权限档和推理档共用这一条，避免两处各写一份区间。 */
export function hasHan(text: string): boolean {
  return /[\u3400-\u9fff]/.test(text);
}

/** 短中文名。长句、带空格或纯英文说明丢掉，界面不去翻译 description。 */
export function shortHanLabel(label: string | null | undefined): string {
  const text = label?.trim() ?? "";
  if (!text || text.length > 8 || /\s/.test(text)) return "";
  return hasHan(text) ? text : "";
}
