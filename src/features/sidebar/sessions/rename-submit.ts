/** 组字期间的回车留给输入法。229 是组字占位码，有些环境这时 isComposing 仍是 false。 */
function composingKey(input: { composing?: boolean; keyCode?: number }): boolean {
  return Boolean(input.composing) || input.keyCode === 229;
}

/** 与「保存」相同：有标题时回车提交，空标题和输入法组字不提交。 */
export function shouldSubmitRename(input: {
  key: string;
  composing?: boolean;
  keyCode?: number;
  title: string;
}): boolean {
  if (input.key !== "Enter") return false;
  if (composingKey(input)) return false;
  return input.title.trim().length > 0;
}
