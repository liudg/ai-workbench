/** 按行拆开源码。末尾换行不再多出空行。 */
export function sourceLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (text.endsWith("\n") && lines[lines.length - 1] === "") lines.pop();
  return lines;
}
