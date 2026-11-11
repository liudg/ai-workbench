import assert from "node:assert/strict";
import { test } from "node:test";

import {
  THEME_OPTIONS,
  THEME_STORAGE_KEY,
  parseThemeOverrideFromSearch,
  parseThemePreference,
  readStoredThemePreference,
  resolveWorkbenchTheme,
  writeStoredThemePreference,
} from "./theme.ts";

test("invalid or missing theme preference falls back to graphite", () => {
  assert.equal(parseThemePreference(null), "graphite");
  assert.equal(parseThemePreference(undefined), "graphite");
  assert.equal(parseThemePreference(""), "graphite");
  assert.equal(parseThemePreference("obsidian"), "graphite");
  assert.equal(parseThemePreference("graphite"), "graphite");
  assert.equal(parseThemePreference("daylight"), "daylight");
  assert.equal(parseThemePreference("system"), "system");
});

test("system theme preference resolves to daylight or graphite from OS color scheme", () => {
  assert.equal(resolveWorkbenchTheme("graphite", true), "graphite");
  assert.equal(resolveWorkbenchTheme("graphite", false), "graphite");
  assert.equal(resolveWorkbenchTheme("daylight", true), "daylight");
  assert.equal(resolveWorkbenchTheme("daylight", false), "daylight");
  assert.equal(resolveWorkbenchTheme("system", true), "daylight");
  assert.equal(resolveWorkbenchTheme("system", false), "graphite");
});

test("theme options expose only concise labels without redundant descriptions", () => {
  assert.deepEqual(
    THEME_OPTIONS.map((item) => item.id),
    ["graphite", "daylight", "system"],
  );
});

test("theme storage round-trips valid preferences and tolerates corrupt values", () => {
  const map = new Map<string, string>();
  const storage = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };

  assert.equal(readStoredThemePreference(storage), "graphite");
  writeStoredThemePreference("daylight", storage);
  assert.equal(map.get(THEME_STORAGE_KEY), "daylight");
  assert.equal(readStoredThemePreference(storage), "daylight");

  map.set(THEME_STORAGE_KEY, "corrupted");
  assert.equal(readStoredThemePreference(storage), "graphite");
});

test("URL ?theme= query override accepts only concrete themes and takes precedence", () => {
  assert.equal(parseThemeOverrideFromSearch(null), null);
  assert.equal(parseThemeOverrideFromSearch(""), null);
  assert.equal(parseThemeOverrideFromSearch("?preview=sidebar"), null);
  assert.equal(parseThemeOverrideFromSearch("?theme=system"), null);
  assert.equal(parseThemeOverrideFromSearch("?preview=sidebar&theme=daylight"), "daylight");
  assert.equal(parseThemeOverrideFromSearch("?theme=graphite"), "graphite");
  assert.equal(resolveWorkbenchTheme("graphite", false, "daylight"), "daylight");
  assert.equal(resolveWorkbenchTheme("daylight", true, "graphite"), "graphite");
});
