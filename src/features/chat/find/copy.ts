/**
 * zh-CN 菜单里读到「查找」「上一个结果」「下一个结果」。
 * 查找条外观、空状态、关闭说法和默认键位未观察。
 * Ctrl+F 是工作台自己的绑定，不把它写成 Codex 官方快捷键。
 */
export const THREAD_FIND_COPY = {
  find: "查找",
  previous: "上一个结果",
  next: "下一个结果",
  close: "关闭",
  empty: "无匹配项",
  shortcut: "Ctrl+F",
} as const;
