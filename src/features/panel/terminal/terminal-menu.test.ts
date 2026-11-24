import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { ContextMenuItem } from "../../../shared/menu/ContextMenu.tsx";
import { buildTerminalContextMenuItems } from "./terminal-menu.ts";

function findAction(items: readonly ContextMenuItem[], id: string) {
  const found = items.find((item) => item.id === id);
  assert.ok(found && !("separator" in found), `missing menu item ${id}`);
  return found;
}

describe("terminal context menu items", () => {
  test("disables selection actions when nothing is selected and includes standard terminal actions", () => {
    let pasted = 0;
    let selectedAll = 0;
    let cleared = 0;

    const items = buildTerminalContextMenuItems({
      draft: null,
      selectedText: "",
      link: null,
      projectPath: "G:/document/ai-workbench",
      hasTerminal: true,
      exited: false,
      onAddToChat: () => undefined,
      onOpenBuiltinUrl: () => undefined,
      onOpenExternalUrl: () => undefined,
      onOpenFile: () => undefined,
      onCopyText: () => undefined,
      onClearSelection: () => undefined,
      onPaste: () => {
        pasted += 1;
      },
      onSelectAll: () => {
        selectedAll += 1;
      },
      onClearTerminal: () => {
        cleared += 1;
      },
    });

    assert.equal(findAction(items, "add-to-chat").disabled, true);
    assert.equal(findAction(items, "copy").disabled, true);
    assert.equal(findAction(items, "paste").disabled, false);
    assert.equal(findAction(items, "select-all").disabled, false);
    assert.equal(findAction(items, "clear").disabled, false);

    findAction(items, "paste").onSelect();
    findAction(items, "select-all").onSelect();
    findAction(items, "clear").onSelect();
    assert.equal(pasted, 1);
    assert.equal(selectedAll, 1);
    assert.equal(cleared, 1);
  });

  test("provides URL actions (built-in browser, system browser, copy link) when right-clicking a URL", () => {
    const builtin: string[] = [];
    const external: string[] = [];
    const copied: string[] = [];

    const items = buildTerminalContextMenuItems({
      draft: null,
      selectedText: "",
      link: { kind: "url", url: "http://localhost:4573/preview" },
      projectPath: "G:/document/ai-workbench",
      hasTerminal: true,
      exited: false,
      onAddToChat: () => undefined,
      onOpenBuiltinUrl: (url) => builtin.push(url),
      onOpenExternalUrl: (url) => external.push(url),
      onOpenFile: () => undefined,
      onCopyText: (text) => copied.push(text),
      onClearSelection: () => undefined,
      onPaste: () => undefined,
      onSelectAll: () => undefined,
      onClearTerminal: () => undefined,
    });

    assert.equal(findAction(items, "open-url-builtin").label, "在内置浏览器打开");
    assert.equal(findAction(items, "open-url-external").label, "在系统浏览器打开");
    assert.equal(findAction(items, "copy-link").label, "复制链接");

    findAction(items, "open-url-builtin").onSelect();
    findAction(items, "open-url-external").onSelect();
    findAction(items, "copy-link").onSelect();
    assert.deepEqual(builtin, ["http://localhost:4573/preview"]);
    assert.deepEqual(external, ["http://localhost:4573/preview"]);
    assert.deepEqual(copied, ["http://localhost:4573/preview"]);
  });

  test("provides verified file actions and sends selection draft to chat", () => {
    const added: string[] = [];
    const opened: Array<{ path: string; line: number | null }> = [];
    const copied: string[] = [];
    let selectionCleared = 0;

    const draft = {
      path: "终端",
      body: "error[E0308]",
      start: 12,
      end: 12,
      quote: "```terminal:12\nerror[E0308]\n```",
    };

    const items = buildTerminalContextMenuItems({
      draft,
      selectedText: "error[E0308]",
      link: {
        kind: "file",
        resolvedPath: "G:\\document\\ai-workbench\\src\\main.rs",
        line: 12,
      },
      projectPath: "G:\\document\\ai-workbench",
      hasTerminal: true,
      exited: true,
      onAddToChat: (d) => added.push(d.quote),
      onOpenBuiltinUrl: () => undefined,
      onOpenExternalUrl: () => undefined,
      onOpenFile: (path, line) => opened.push({ path, line }),
      onCopyText: (text) => copied.push(text),
      onClearSelection: () => {
        selectionCleared += 1;
      },
      onPaste: () => undefined,
      onSelectAll: () => undefined,
      onClearTerminal: () => undefined,
    });

    assert.equal(findAction(items, "add-to-chat").disabled, false);
    assert.equal(findAction(items, "paste").disabled, true);
    assert.equal(findAction(items, "open-file").label, "打开文件");
    assert.equal(findAction(items, "copy-path").label, "复制路径");

    findAction(items, "add-to-chat").onSelect();
    findAction(items, "open-file").onSelect();
    findAction(items, "copy-path").onSelect();
    findAction(items, "copy").onSelect();

    assert.deepEqual(added, ["```terminal:12\nerror[E0308]\n```"]);
    assert.deepEqual(opened, [{ path: "G:\\document\\ai-workbench\\src\\main.rs", line: 12 }]);
    assert.deepEqual(copied, ["src/main.rs", "error[E0308]"]);
    assert.equal(selectionCleared, 2);
  });
});
