/** 文件树点中一份差异时，展开这一份，其它文件保持收起或展开。 */
export function pathsWithFileOpen(paths: readonly string[], path: string): readonly string[] {
  if (!path || paths.includes(path)) return paths;
  return [...paths, path];
}

/** 把左侧差异列表滚到这份文件的标题。不滚右侧文件树。 */
export function scrollDiffFileIntoView(path: string, root: ParentNode | null = defaultRoot()): boolean {
  if (!root || !path) return false;
  const nodes = root.querySelectorAll("[data-diff-file-body]");
  let section: Element | null = null;
  for (const node of nodes) {
    if (node.getAttribute("data-diff-file-body") === path) {
      section = node;
      break;
    }
  }
  if (!(section instanceof HTMLElement)) return false;
  const scroller = section.closest("[data-diff-wrap]");
  if (!(scroller instanceof HTMLElement)) {
    section.scrollIntoView({ block: "start" });
    return true;
  }
  const top = section.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  scroller.scrollTop = Math.max(0, top);
  return true;
}

function defaultRoot(): ParentNode | null {
  return typeof document === "undefined" ? null : document;
}
