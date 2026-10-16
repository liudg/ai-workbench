/** 时间线上的红条。占位词和整段 JSON 不画出来。 */
export function visibleErrorText(message: string): string | null {
  const trimmed = message.trim();
  if (!trimmed) return null;
  if (/^(null|undefined|unknown|unknown error)$/i.test(trimmed)) return null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return null;
  return trimmed;
}
