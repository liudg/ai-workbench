import assert from "node:assert/strict";
import { test } from "node:test";

import {
  THEME_OPTIONS,
  getResolvedTheme,
  getThemePreference,
  parseThemePreference,
  resolveTheme,
  setThemePreference,
  subscribeTheme,
  toggleTheme,
} from "./theme.ts";

test("THEME_OPTIONS uses plain Chinese labels in daylight-obsidian-system order", () => {
  assert.deepEqual(
    THEME_OPTIONS.map((item) => ({ id: item.id, label: item.label })),
    [
      { id: "daylight", label: "浅色" },
      { id: "obsidian", label: "深色" },
      { id: "system", label: "跟随系统" },
    ],
  );
});

test("parseThemePreference falls back to obsidian for unknown values", () => {
  assert.equal(parseThemePreference(null), "obsidian");
  assert.equal(parseThemePreference(""), "obsidian");
  assert.equal(parseThemePreference("neon"), "obsidian");
  assert.equal(parseThemePreference("obsidian"), "obsidian");
  assert.equal(parseThemePreference("daylight"), "daylight");
  assert.equal(parseThemePreference("system"), "system");
});

test("resolveTheme maps explicit and system preferences", () => {
  assert.equal(resolveTheme("obsidian", true), "obsidian");
  assert.equal(resolveTheme("daylight", false), "daylight");
  assert.equal(resolveTheme("system", false), "obsidian");
  assert.equal(resolveTheme("system", true), "daylight");
});

test("setThemePreference and toggleTheme notify subscribers", () => {
  setThemePreference("obsidian");
  let count = 0;
  const unsubscribe = subscribeTheme(() => {
    count += 1;
  });
  try {
    assert.equal(getThemePreference(), "obsidian");
    assert.equal(getResolvedTheme(), "obsidian");

    assert.equal(toggleTheme(), "daylight");
    assert.equal(getThemePreference(), "daylight");
    assert.equal(getResolvedTheme(), "daylight");
    assert.equal(count, 1);

    assert.equal(toggleTheme(), "obsidian");
    assert.equal(getThemePreference(), "obsidian");
    assert.equal(getResolvedTheme(), "obsidian");
    assert.equal(count, 2);
  } finally {
    unsubscribe();
  }
});

test("setThemePreference syncs dataset.theme, .dark class, and colorScheme on documentElement", () => {
  const classes = new Set<string>(["dark"]);
  const fakeRoot = {
    dataset: {} as Record<string, string>,
    style: { colorScheme: "" },
    classList: {
      toggle(name: string, force?: boolean) {
        const shouldAdd = force ?? !classes.has(name);
        if (shouldAdd) classes.add(name);
        else classes.delete(name);
        return shouldAdd;
      },
    },
  };
  const prevDoc = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    writable: true,
    value: { documentElement: fakeRoot },
  });
  try {
    setThemePreference("daylight");
    assert.equal(fakeRoot.dataset.theme, "daylight");
    assert.equal(classes.has("dark"), false);
    assert.equal(fakeRoot.style.colorScheme, "light");

    setThemePreference("obsidian");
    assert.equal(fakeRoot.dataset.theme, "obsidian");
    assert.equal(classes.has("dark"), true);
    assert.equal(fakeRoot.style.colorScheme, "dark");
  } finally {
    if (prevDoc) Object.defineProperty(globalThis, "document", prevDoc);
    else Reflect.deleteProperty(globalThis, "document");
  }
});
