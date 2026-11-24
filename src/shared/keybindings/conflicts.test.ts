import assert from "node:assert/strict";
import { test } from "node:test";

import { areWhenClausesOverlapping, conflictsByCommand, detectKeybindingConflicts } from "./conflicts.ts";
import {
  DEFAULT_KEYBINDINGS,
  formatCommandShortcut,
  matchKeybinding,
  resolveKeybindings,
} from "./defaults.ts";
import type { KeybindingRule } from "./types.ts";

test("DEFAULT_KEYBINDINGS has zero conflicts on Windows, Linux, and macOS", () => {
  for (const platform of ["windows", "linux", "mac"] as const) {
    const resolved = resolveKeybindings(DEFAULT_KEYBINDINGS, [], platform);
    assert.deepEqual(detectKeybindingConflicts(resolved, platform), [], `platform: ${platform}`);
  }
});

test("platform-aware chord normalization detects mod+k and ctrl+k on Windows/Linux (and meta+k on macOS) as the same chord", () => {
  const rules: KeybindingRule[] = [
    { command: "cmd.one", key: "mod+k" },
    { command: "cmd.two", key: "ctrl+k" },
  ];
  assert.equal(detectKeybindingConflicts(rules, "windows").length, 1);
  assert.equal(detectKeybindingConflicts(rules, "linux").length, 1);
  assert.equal(detectKeybindingConflicts(rules, "mac").length, 0);

  const macRules: KeybindingRule[] = [
    { command: "cmd.one", key: "mod+k" },
    { command: "cmd.two", key: "meta+k" },
  ];
  assert.equal(detectKeybindingConflicts(macRules, "mac").length, 1);
  assert.equal(detectKeybindingConflicts(macRules, "windows").length, 0);
});

test("truth-table satisfiability proves mutually exclusive when clauses do NOT conflict while overlapping clauses DO conflict", () => {
  // terminalFocus 与 !terminalFocus 严格互斥 -> 不冲突
  assert.equal(areWhenClausesOverlapping("terminalFocus", "!terminalFocus"), false);
  assert.equal(
    detectKeybindingConflicts(
      [
        { command: "a", key: "mod+k", when: "terminalFocus" },
        { command: "b", key: "mod+k", when: "!terminalFocus" },
      ],
      "windows",
    ).length,
    0,
  );

  // 德摩根定律：!(sessionActive || modalOpen) 与 sessionActive 互斥 -> 不冲突
  assert.equal(areWhenClausesOverlapping("!(sessionActive || modalOpen)", "sessionActive"), false);

  // isDesktop 与 isWeb 在真实环境严格互补 -> 不冲突
  assert.equal(areWhenClausesOverlapping("isDesktop", "isWeb"), false);

  // 空 when 与任意可满足条件存在交集 -> 冲突
  assert.equal(areWhenClausesOverlapping(undefined, "!terminalFocus"), true);

  // sessionActive && !terminalFocus 与 projectActive && !terminalFocus 在两者皆激活时同时成立 -> 冲突
  const overlapping = detectKeybindingConflicts(
    [
      { command: "chat.find", key: "mod+f", when: "sessionActive && !terminalFocus" },
      { command: "files.search", key: "ctrl+f", when: "projectActive && !terminalFocus" },
    ],
    "windows",
  );
  assert.equal(overlapping.length, 1);
  const byCmd = conflictsByCommand(overlapping);
  assert.deepEqual(byCmd.get("chat.find"), ["files.search"]);
  assert.deepEqual(byCmd.get("files.search"), ["chat.find"]);

  // when === "false" 为禁用规则 -> 不冲突
  assert.equal(
    detectKeybindingConflicts(
      [
        { command: "a", key: "mod+k", when: "false" },
        { command: "b", key: "mod+k" },
      ],
      "windows",
    ).length,
    0,
  );
});

test("resolveKeybindings supports unbinding (-command, key: '', when: 'false') and last-matching-rule priority", () => {
  // 通过 key: "" 解绑 sidebar.toggle
  const unbound = resolveKeybindings(DEFAULT_KEYBINDINGS, [{ command: "sidebar.toggle", key: "" }], "windows");
  assert.equal(formatCommandShortcut("sidebar.toggle", unbound, "windows"), undefined);

  // 通过 -command 指定具体按键解绑 commandMenu.toggle 的 mod+k，保留 mod+shift+p
  const partialUnbound = resolveKeybindings(
    DEFAULT_KEYBINDINGS,
    [{ command: "-commandMenu.toggle", key: "mod+k" }],
    "windows",
  );
  assert.equal(formatCommandShortcut("commandMenu.toggle", partialUnbound, "windows"), "Ctrl+Shift+P");

  // 用户自定义规则排在后面，相同和弦命中时最后一条生效
  const overridden = resolveKeybindings(
    DEFAULT_KEYBINDINGS,
    [{ command: "board.toggle", key: "mod+b" }],
    "windows",
  );
  const winner = matchKeybinding(
    { key: "b", code: "KeyB", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false },
    {},
    overridden,
    "windows",
  );
  assert.equal(winner?.command, "board.toggle");
});
