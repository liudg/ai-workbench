import assert from "node:assert/strict";
import { test } from "node:test";
import { Window } from "happy-dom";

import { DEFAULT_KEYBINDINGS, resolveKeybindings } from "../../../shared/keybindings/defaults.ts";
import { clearThreadMarks, paintThreadHits } from "./highlight.ts";
import { collectTextHits, resolveQueryInTargetNode, stepHit } from "./hits.ts";
import { matchesThreadFindBinding } from "./keyboard.ts";

test("matchesThreadFindBinding matches platform Mod+F without shift/alt and ignores Ctrl+F on macOS", () => {
  const winRules = resolveKeybindings(DEFAULT_KEYBINDINGS, [], "windows");
  const macRules = resolveKeybindings(DEFAULT_KEYBINDINGS, [], "mac");
  const base = { key: "f", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
  assert.equal(matchesThreadFindBinding({ ...base, ctrlKey: true }, winRules, "windows"), true);
  assert.equal(matchesThreadFindBinding({ ...base, metaKey: true, key: "F" }, macRules, "mac"), true);
  assert.equal(matchesThreadFindBinding({ ...base, ctrlKey: true }, macRules, "mac"), false);
  assert.equal(matchesThreadFindBinding({ ...base, ctrlKey: true, shiftKey: true }, winRules, "windows"), false);
  assert.equal(matchesThreadFindBinding({ ...base, ctrlKey: true, altKey: true }, winRules, "windows"), false);
  assert.equal(matchesThreadFindBinding(base, winRules, "windows"), false);

  const projectOnlyRules = resolveKeybindings(
    DEFAULT_KEYBINDINGS,
    [{ command: "chat.find", key: "mod+g", when: "projectActive" }],
    "windows",
  );
  assert.equal(matchesThreadFindBinding({ ...base, key: "g", ctrlKey: true }, projectOnlyRules, "windows", false), false);
  assert.equal(matchesThreadFindBinding({ ...base, key: "g", ctrlKey: true }, projectOnlyRules, "windows", true), true);
});

test("hits step wraps and an empty query matches nothing", () => {
  assert.equal(stepHit(0, 3, 1), 1);
  assert.equal(stepHit(2, 3, 1), 0);
  assert.equal(stepHit(0, 3, -1), 2);
  assert.equal(stepHit(0, 0, 1), 0);
});

test("search reads visible timeline text and skips hidden nodes", () => {
  const dom = new Window();
  const root = dom.document.createElement("div");
  root.innerHTML = [
    "<p>装备对比提示</p>",
    "<p>再看一次装备颜色</p>",
    "<div hidden>隐藏的装备</div>",
    "<textarea>输入框里的装备</textarea>",
    "<script>装备</script>",
  ].join("");
  const hits = collectTextHits(root as unknown as Node, "装备");
  assert.deepEqual(
    hits.map((hit) => hit.node.textContent?.slice(hit.start, hit.end)),
    ["装备", "装备"],
  );
  assert.equal(collectTextHits(root as unknown as Node, "  ").length, 0);
  assert.equal(collectTextHits(root as unknown as Node, "EQUIP").length, 0);
  const folded = dom.document.createElement("div");
  folded.innerHTML = "<span>Case</span>";
  assert.equal(collectTextHits(folded as unknown as Node, "case").length, 1);
});

test("marks paint the current hit and clear back to plain text", () => {
  const dom = new Window();
  const root = dom.document.createElement("div");
  root.innerHTML = "<p>装备对比和装备颜色</p>";
  const hits = collectTextHits(root as unknown as Node, "装备");
  paintThreadHits(hits, 1);
  const marks = root.querySelectorAll("mark[data-thread-find-mark]");
  assert.equal(marks.length, 2);
  assert.equal(marks[0]?.getAttribute("data-thread-find-mark"), "hit");
  assert.equal(marks[1]?.getAttribute("data-thread-find-mark"), "current");
  assert.equal(root.textContent, "装备对比和装备颜色");
  clearThreadMarks(root as unknown as ParentNode);
  assert.equal(root.querySelector("mark"), null);
  assert.equal(root.textContent, "装备对比和装备颜色");
});

test("resolveQueryInTargetNode strips inline backticks and ** so Markdown-rendered code/bold hits match", () => {
  const dom = new Window();
  const root = dom.document.createElement("div");
  root.innerHTML = "<p>调用 <code>fetch_user_token</code> 时触发了 <strong>AuthError</strong> 异常</p>";
  const node = root as unknown as Node;

  assert.equal(resolveQueryInTargetNode(node, "`fetch_user_token`"), "fetch_user_token");
  assert.equal(resolveQueryInTargetNode(node, "**AuthError**"), "AuthError");
  assert.equal(
    resolveQueryInTargetNode(node, "`fetch_user_token` **AuthError**"),
    "fetch_user_token",
  );
  assert.equal(resolveQueryInTargetNode(node, "`**`"), null);
});
