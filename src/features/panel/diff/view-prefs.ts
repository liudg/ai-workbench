import {
  DEFAULT_DIFF_MENU_OPTIONS,
  type DiffMenuOptions,
} from "./diff-menu-options.ts";
import type { DiffLayoutMode } from "./split-rows.ts";

/** 同一会话里切走标签再回来时要保留的差异视图开关。 */
export type DiffFileOpenMode = "default" | "all" | "collapsed" | "custom";

export interface DiffViewPrefs {
  layout: DiffLayoutMode;
  wrap: boolean;
  filesOpen: boolean;
  fileOpen: DiffFileOpenMode;
  openPaths: string[];
  scope: string;
  menu: DiffMenuOptions;
}

export function defaultDiffViewPrefs(menu: DiffMenuOptions = DEFAULT_DIFF_MENU_OPTIONS): DiffViewPrefs {
  return {
    layout: "auto",
    wrap: true,
    filesOpen: true,
    fileOpen: "default",
    openPaths: [],
    scope: "",
    menu: { ...menu },
  };
}

export function mergeDiffViewPrefs(current: DiffViewPrefs, patch: Partial<DiffViewPrefs>): DiffViewPrefs {
  return {
    ...current,
    ...patch,
    menu: patch.menu ? { ...current.menu, ...patch.menu } : current.menu,
    openPaths: patch.openPaths ? patch.openPaths.slice() : current.openPaths,
  };
}

export function diffViewPrefsEqual(a: DiffViewPrefs, b: DiffViewPrefs): boolean {
  if (
    a.layout !== b.layout ||
    a.wrap !== b.wrap ||
    a.filesOpen !== b.filesOpen ||
    a.fileOpen !== b.fileOpen ||
    a.scope !== b.scope
  ) {
    return false;
  }
  if (a.openPaths.length !== b.openPaths.length) return false;
  for (let index = 0; index < a.openPaths.length; index += 1) {
    if (a.openPaths[index] !== b.openPaths[index]) return false;
  }
  const keys = Object.keys(a.menu) as Array<keyof DiffMenuOptions>;
  return keys.every((key) => a.menu[key] === b.menu[key]);
}

/** 文件集合变化时按记住的模式重开，不把用户选过的并排/展开打回默认。 */
export function pathsForFileOpen(
  mode: DiffFileOpenMode,
  saved: readonly string[],
  available: readonly string[],
): string[] {
  if (mode === "all") return available.slice();
  if (mode === "collapsed") return [];
  if (mode === "custom") {
    const have = new Set(available);
    return saved.filter((path) => have.has(path));
  }
  const first = available[0];
  return first ? [first] : [];
}

export function modeForPaths(paths: readonly string[], available: readonly string[]): DiffFileOpenMode {
  if (
    available.length > 0 &&
    paths.length === available.length &&
    available.every((path) => paths.includes(path))
  ) {
    return "all";
  }
  if (paths.length === 0) return "collapsed";
  return "custom";
}
