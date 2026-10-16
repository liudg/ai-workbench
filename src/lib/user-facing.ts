/** 只留下给人看的短句。null、undefined、JSON 和异常原文都不显示。 */
export function userFacingMessage(value: unknown): string | null {
  const text =
    typeof value === "string" ? value : value instanceof Error ? value.message : "";
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (/^(null|undefined)$/i.test(trimmed)) return null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return null;
  if (/^(TypeError|SyntaxError|ReferenceError|RangeError|Error)\b/.test(trimmed)) return null;
  if (trimmed.includes("\n    at ")) return null;
  return trimmed;
}
