/** `···` 菜单里的勾选。关侧栏或重开应用后仍用这份，不回到默认。 */

export const DIFF_MENU_OPTIONS_KEY = "ai-workbench.diff-menu-options";

export interface DiffMenuOptions {
  loadFull: boolean;
  renderPreview: boolean;
  wordDiff: boolean;
  hideWhitespace: boolean;
  hideImports: boolean;
}

export const DEFAULT_DIFF_MENU_OPTIONS: DiffMenuOptions = {
  loadFull: false,
  // 展开默认是差异 hunk。渲染预览会把 Markdown 换成渲染结果，不能当默认。
  renderPreview: false,
  wordDiff: true,
  hideWhitespace: false,
  hideImports: false,
};

export interface DiffMenuStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const KEYS = ["loadFull", "renderPreview", "wordDiff", "hideWhitespace", "hideImports"] as const;

export function readDiffMenuOptions(storage: DiffMenuStorage | null): DiffMenuOptions {
  const fallback = { ...DEFAULT_DIFF_MENU_OPTIONS };
  if (!storage) return fallback;
  let raw: string | null;
  try {
    raw = storage.getItem(DIFF_MENU_OPTIONS_KEY);
  } catch {
    return fallback;
  }
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as Partial<Record<(typeof KEYS)[number], unknown>>;
    const next = { ...fallback };
    for (const key of KEYS) {
      if (typeof parsed[key] === "boolean") next[key] = parsed[key];
    }
    return next;
  } catch {
    return fallback;
  }
}

export function writeDiffMenuOptions(options: DiffMenuOptions, storage: DiffMenuStorage | null): void {
  if (!storage) return;
  try {
    storage.setItem(DIFF_MENU_OPTIONS_KEY, JSON.stringify(options));
  } catch {
    // 无痕模式或配额满时仍能切换，只是这次不能记住。
  }
}

export function browserDiffMenuStorage(): DiffMenuStorage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}
