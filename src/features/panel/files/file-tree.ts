import { directoryOf, normalizePath } from "./path.ts";

export interface FileTreeFile {
  path: string;
  added: number;
  removed: number;
}

export interface FileTreeNode<T extends FileTreeFile> {
  id: string;
  name: string;
  path: string;
  kind: "dir" | "file";
  count: number;
  added: number;
  removed: number;
  file?: T;
  children: FileTreeNode<T>[];
}

interface Draft<T extends FileTreeFile> {
  name: string;
  path: string;
  dirs: Map<string, Draft<T>>;
  files: T[];
}

/** 按路径嵌套成目录树。文件夹上的数量是它下面的变更文件数。 */
export function buildFileTree<T extends FileTreeFile>(files: readonly T[]): FileTreeNode<T>[] {
  const root: Draft<T> = { name: "", path: "", dirs: new Map(), files: [] };
  for (const file of files) {
    const normalized = normalizePath(file.path);
    const dir = directoryOf(normalized);
    const parts = dir ? dir.split("/") : [];
    let cursor = root;
    let walked = "";
    for (const part of parts) {
      walked = walked ? `${walked}/${part}` : part;
      let next = cursor.dirs.get(part);
      if (!next) {
        next = { name: part, path: walked, dirs: new Map(), files: [] };
        cursor.dirs.set(part, next);
      }
      cursor = next;
    }
    cursor.files.push({ ...file, path: normalized });
  }
  return compress(finish(root));
}

/** 只有一个子目录的层级合成一条路径，文件夹行才能同时看到路径和数量。 */
function compress<T extends FileTreeFile>(nodes: FileTreeNode<T>[]): FileTreeNode<T>[] {
  return nodes.map((node) => {
    if (node.kind !== "dir") return node;
    let current: FileTreeNode<T> = { ...node, children: compress(node.children) };
    while (current.children.length === 1 && current.children[0]?.kind === "dir") {
      const child = current.children[0];
      current = {
        ...child,
        name: `${current.name}/${child.name}`,
      };
    }
    return current;
  });
}

/** 目录行把压缩后的路径写成 Codex 那样的「Assets / Scripts」。 */
export function treePathLabel(name: string): string {
  return name.replaceAll("/", " / ");
}

export function directoryIds<T extends FileTreeFile>(nodes: readonly FileTreeNode<T>[]): string[] {
  const ids: string[] = [];
  const walk = (list: readonly FileTreeNode<T>[]) => {
    for (const node of list) {
      if (node.kind !== "dir") continue;
      ids.push(node.id);
      walk(node.children);
    }
  };
  walk(nodes);
  return ids;
}

function finish<T extends FileTreeFile>(draft: Draft<T>): FileTreeNode<T>[] {
  const dirs = [...draft.dirs.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((dir) => {
      const children = finish(dir);
      const count = children.reduce((sum, child) => sum + child.count, 0);
      const added = children.reduce((sum, child) => sum + child.added, 0);
      const removed = children.reduce((sum, child) => sum + child.removed, 0);
      return {
        id: dir.path,
        name: dir.name,
        path: dir.path,
        kind: "dir" as const,
        count,
        added,
        removed,
        children,
      };
    });
  const files = [...draft.files]
    .sort((a, b) => fileName(a.path).localeCompare(fileName(b.path)))
    .map((file) => ({
      id: file.path,
      name: fileName(file.path),
      path: file.path,
      kind: "file" as const,
      count: 1,
      added: file.added,
      removed: file.removed,
      file,
      children: [],
    }));
  return [...dirs, ...files];
}

function fileName(path: string): string {
  const index = path.lastIndexOf("/");
  return index >= 0 ? path.slice(index + 1) : path;
}
