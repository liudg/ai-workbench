import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_WHEN_DEPTH,
  collectWhenVariables,
  evaluateWhen,
  findUnknownWhenVariables,
  parseWhen,
  serializeWhen,
  validateWhenExpression,
} from "./when.ts";

test("empty or whitespace when expression parses to null and evaluates to true", () => {
  assert.deepEqual(parseWhen(undefined), { ok: true, ast: null });
  assert.deepEqual(parseWhen(""), { ok: true, ast: null });
  assert.deepEqual(parseWhen("   \t\n "), { ok: true, ast: null });
  assert.equal(serializeWhen(null), "");
  assert.equal(evaluateWhen(undefined, {}), true);
  assert.equal(evaluateWhen("  ", {}), true);
});

test("operator precedence: ! binds tighter than &&, which binds tighter than ||", () => {
  const parsed = parseWhen("!terminalFocus && sessionActive || modalOpen && !inputFocus");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(serializeWhen(parsed.ast), "!terminalFocus && sessionActive || modalOpen && !inputFocus");

  assert.equal(
    evaluateWhen("!terminalFocus && sessionActive || modalOpen && !inputFocus", {
      terminalFocus: false,
      sessionActive: true,
      modalOpen: false,
      inputFocus: true,
    }),
    true,
  );
  assert.equal(
    evaluateWhen("!terminalFocus && sessionActive || modalOpen && !inputFocus", {
      terminalFocus: true,
      sessionActive: true,
      modalOpen: true,
      inputFocus: false,
    }),
    true,
  );
  assert.equal(
    evaluateWhen("!terminalFocus && sessionActive || modalOpen && !inputFocus", {
      terminalFocus: true,
      sessionActive: true,
      modalOpen: true,
      inputFocus: true,
    }),
    false,
  );
});

test("parentheses, double negation, and boolean literals serialize minimally", () => {
  const grouped = parseWhen("!(commandMenuOpen || modalOpen) && (isDesktop || isWeb)");
  assert.equal(grouped.ok, true);
  if (!grouped.ok) return;
  assert.equal(serializeWhen(grouped.ast), "!(commandMenuOpen || modalOpen) && (isDesktop || isWeb)");

  const redundant = parseWhen("((!(!sidebarOpen))) && (true)");
  assert.equal(redundant.ok, true);
  if (!redundant.ok) return;
  assert.equal(serializeWhen(redundant.ast), "!!sidebarOpen && true");
  assert.equal(evaluateWhen("false", { sidebarOpen: true }), false);
  assert.equal(evaluateWhen("true", { sidebarOpen: false }), true);
});

test("unknown variable detector identifies unsupported identifiers while accepting all 13 builtin variables", () => {
  const allBuiltin = [
    "terminalFocus",
    "composerFocus",
    "inputFocus",
    "commandMenuOpen",
    "modalOpen",
    "sidebarOpen",
    "panelOpen",
    "settingsOpen",
    "boardOpen",
    "sessionActive",
    "projectActive",
    "isDesktop",
    "isWeb",
  ].join(" || ");

  const valid = validateWhenExpression(allBuiltin);
  assert.equal(valid.valid, true);
  assert.deepEqual(valid.unknownVariables, []);

  const invalid = validateWhenExpression("sessionActive && !editorTextFocus && fooBar");
  assert.equal(invalid.valid, false);
  assert.deepEqual(invalid.unknownVariables, ["editorTextFocus", "fooBar"]);
  assert.deepEqual(findUnknownWhenVariables("!unknownVar || sidebarOpen"), ["unknownVar"]);

  const literalFalse = validateWhenExpression(" ( false ) ");
  assert.equal(literalFalse.valid, false);
  assert.equal(literalFalse.error, "要停用快捷键请点击清除按钮，不要将 when 设为 false");

  const parsed = parseWhen("terminalFocus && !terminalFocus || composerFocus");
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.deepEqual(collectWhenVariables(parsed.ast), ["terminalFocus", "composerFocus"]);
  }
});

test("syntax errors and max depth guard fail cleanly without throwing", () => {
  for (const bad of ["&&", "terminalFocus &&", "(terminalFocus", "()", "terminalFocus | modalOpen", "a b", "foo@bar"]) {
    const res = parseWhen(bad);
    assert.equal(res.ok, false, `expected failure for: ${bad}`);
    assert.equal(evaluateWhen(bad, { terminalFocus: true }), false);
  }

  const deepParens = `${"(".repeat(MAX_WHEN_DEPTH + 2)}terminalFocus${")".repeat(MAX_WHEN_DEPTH + 2)}`;
  const deepRes = parseWhen(deepParens);
  assert.equal(deepRes.ok, false);

  const deepNots = `${"!".repeat(MAX_WHEN_DEPTH + 2)}terminalFocus`;
  const deepNotRes = parseWhen(deepNots);
  assert.equal(deepNotRes.ok, false);
});
