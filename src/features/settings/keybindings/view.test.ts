import assert from "node:assert/strict";
import { test } from "node:test";

import { KEYBINDING_COMMAND_BY_ID } from "../../../shared/keybindings/defaults.ts";
import {
  buildKeybindingDisplayRows,
  filterKeybindingRows,
  previewRecordingConflicts,
  resetCommandToDefault,
  setCommandShortcutAndWhen,
  unbindCommandShortcut,
} from "./view.ts";

test("buildKeybindingDisplayRows computes customized state, conflict titles, and filter counts", () => {
  const userRules = [
    // 与 sidebar.toggle (默认 mod+b) 发生冲突
    { command: "board.toggle", key: "ctrl+b" },
  ];
  const { rows, conflictCount, modifiedCount } = buildKeybindingDisplayRows(userRules, "windows");
  assert.equal(modifiedCount, 1);
  assert.equal(conflictCount, 2);

  const boardRow = rows.find((r) => r.id === "board.toggle");
  const sidebarRow = rows.find((r) => r.id === "sidebar.toggle");
  assert.equal(boardRow?.isCustomized, true);
  assert.equal(boardRow?.shortcutLabel, "Ctrl+B");
  assert.deepEqual(boardRow?.conflictTitles, ["显示/隐藏侧边栏"]);
  assert.deepEqual(sidebarRow?.conflictTitles, ["打开看板"]);

  assert.equal(
    filterKeybindingRows(rows, { query: "", onlyConflicts: true, onlyModified: false }).length,
    2,
  );
  assert.equal(
    filterKeybindingRows(rows, { query: "", onlyConflicts: false, onlyModified: true }).length,
    1,
  );
  assert.equal(
    filterKeybindingRows(rows, { query: "!terminalFocus", onlyConflicts: false, onlyModified: false }).some(
      (r) => r.id === "commandMenu.toggle",
    ),
    true,
  );
});

test("setCommandShortcutAndWhen, unbindCommandShortcut, resetCommandToDefault, and previewRecordingConflicts", () => {
  const sidebarMeta = KEYBINDING_COMMAND_BY_ID.get("sidebar.toggle")!;
  const boardMeta = KEYBINDING_COMMAND_BY_ID.get("board.toggle")!;

  // 修改已有默认快捷键的命令会先写一条 key: "" 解绑默认，再追加新规则
  const rebound = setCommandShortcutAndWhen([], sidebarMeta, "mod+\\", "!terminalFocus", "windows");
  assert.deepEqual(rebound, [
    { command: "sidebar.toggle", key: "" },
    { command: "sidebar.toggle", key: "mod+\\", when: "!terminalFocus" },
  ]);

  // 改回与默认完全一致时自动清空冗余用户规则
  assert.deepEqual(setCommandShortcutAndWhen(rebound, sidebarMeta, "mod+b", undefined, "windows"), []);

  // 默认未绑定的命令直接写入自定义规则
  const assigned = setCommandShortcutAndWhen([], boardMeta, "mod+j", undefined, "windows");
  assert.deepEqual(assigned, [{ command: "board.toggle", key: "mod+j" }]);
  assert.deepEqual(unbindCommandShortcut(assigned, boardMeta), []);
  assert.deepEqual(unbindCommandShortcut([], sidebarMeta), [{ command: "sidebar.toggle", key: "" }]);
  assert.deepEqual(resetCommandToDefault(rebound, "sidebar.toggle"), []);

  // 录制预览冲突检测
  assert.deepEqual(previewRecordingConflicts([], boardMeta, "mod+b", undefined, "windows"), ["显示/隐藏侧边栏"]);
  assert.deepEqual(previewRecordingConflicts([], boardMeta, "mod+k", "terminalFocus", "windows"), []);

  // 含 secondaryDefaults 的命令修改主快捷键或 when 时保留辅助默认快捷键（如 mod+shift+p、mod+shift+backspace）
  const cmdMenuMeta = KEYBINDING_COMMAND_BY_ID.get("commandMenu.toggle")!;
  const updatedCmdMenu = setCommandShortcutAndWhen(
    [],
    cmdMenuMeta,
    "mod+j",
    "!terminalFocus",
    "windows",
  );
  assert.deepEqual(updatedCmdMenu, [
    { command: "-commandMenu.toggle", key: "mod+k", when: "!terminalFocus" },
    { command: "commandMenu.toggle", key: "mod+j", when: "!terminalFocus" },
  ]);
  const { rows: afterSecondaryRows } = buildKeybindingDisplayRows(updatedCmdMenu, "windows");
  const cmdMenuRow = afterSecondaryRows.find((r) => r.id === "commandMenu.toggle");
  assert.equal(cmdMenuRow?.shortcutLabel, "Ctrl+J");
  assert.deepEqual(cmdMenuRow?.secondaryLabels, ["Ctrl+Shift+P"]);
});
