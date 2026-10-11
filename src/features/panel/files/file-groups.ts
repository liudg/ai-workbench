import { directoryOf } from "./path.ts";

export function groupByDirectory<T extends { path: string }>(
  files: readonly T[],
): { dir: string; files: T[] }[] {
  const order: string[] = [];
  const map = new Map<string, T[]>();
  for (const file of files) {
    const dir = directoryOf(file.path);
    const list = map.get(dir);
    if (list) list.push(file);
    else {
      order.push(dir);
      map.set(dir, [file]);
    }
  }
  return order.map((dir) => ({ dir, files: map.get(dir) ?? [] }));
}
