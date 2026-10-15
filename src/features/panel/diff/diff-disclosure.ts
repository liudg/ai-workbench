/**
 * Codex `code-diff` 文件头函数同时把 `rotate-0` 和 `rotate-90` 定义到同一个 binding，
 * 并带有 `open` / `onFileToggle`。语义图没有给出三元分支的顺序。
 * 展开用 `rotate-90`，和回合折叠已经落地的方向一致：收起指向右，展开指向下。
 */
export function diffFileDisclosureClass(open: boolean): "rotate-0" | "rotate-90" {
  return open ? "rotate-90" : "rotate-0";
}
