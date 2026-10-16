/** 组字期间的按键留给输入法。229 是组字占位码，有些环境这时 isComposing 仍是 false。 */
export function isImeKey(input: { composing?: boolean; keyCode?: number }): boolean {
  return Boolean(input.composing) || input.keyCode === 229;
}
