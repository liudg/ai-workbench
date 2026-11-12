import assert from "node:assert/strict";
import { test } from "node:test";

import { terminalThemeFor } from "./terminal-theme.ts";

test("terminalThemeFor provides complete dark and light ANSI palettes with contrasting cursorAccent", () => {
  const dark = terminalThemeFor("obsidian");
  const light = terminalThemeFor("daylight");

  assert.notEqual(dark.cursor, dark.cursorAccent);
  assert.notEqual(light.cursor, light.cursorAccent);
  assert.equal(light.cursor, "#14171f");
  assert.equal(light.cursorAccent, "#f7f8fa");
  assert.ok(light.selectionBackground?.includes("59, 91, 219"));
  assert.ok(dark.selectionBackground?.includes("94, 129, 255"));

  for (const palette of [dark, light]) {
    for (const key of [
      "black",
      "red",
      "green",
      "yellow",
      "blue",
      "magenta",
      "cyan",
      "white",
      "brightBlack",
      "brightRed",
      "brightGreen",
      "brightYellow",
      "brightBlue",
      "brightMagenta",
      "brightCyan",
      "brightWhite",
    ] as const) {
      assert.ok(palette[key], `missing ${key}`);
    }
  }
});

test("terminalThemeFor ignores transparent host colors so block cursor text stays legible", () => {
  for (const transparent of ["", "  ", "transparent", "rgba(0, 0, 0, 0)", "rgba(0,0,0,0.0)", "#00000000", "#0000"]) {
    const dark = terminalThemeFor("obsidian", transparent, transparent);
    assert.equal(dark.background, "#0d0f13");
    assert.equal(dark.foreground, "#ededf0");
    assert.equal(dark.cursorAccent, "#0d0f13");

    const light = terminalThemeFor("daylight", transparent, transparent);
    assert.equal(light.background, "#f7f8fa");
    assert.equal(light.foreground, "#14171f");
    assert.equal(light.cursorAccent, "#f7f8fa");
  }
});
