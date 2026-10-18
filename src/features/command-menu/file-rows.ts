import { baseName, directoryOf } from "../../shared/path.ts";

import type { PaletteRow } from "./commands.ts";
import { COMMAND_MENU_COPY as COPY } from "./copy.ts";

/** 把索引里的相对路径收成命令菜单的一行：文件名在前，目录在后。 */
export function fileRows(paths: readonly string[]): PaletteRow[] {
  return paths.map((path) => {
    const normalized = path.replace(/\\/g, "/");
    const directory = directoryOf(normalized);
    return {
      key: `file:${normalized}`,
      kind: "file",
      filePath: normalized,
      label: baseName(normalized),
      detail: directory || undefined,
      group: "files",
      groupLabel: COPY.groups.files,
    };
  });
}
