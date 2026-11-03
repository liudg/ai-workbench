import assert from "node:assert/strict";
import { test } from "node:test";
import { Window } from "happy-dom";

import { CHAT_SCOPE_ATTR, sameChatScope } from "./chat-scope.ts";

test("keys and focus stay inside the chat they belong to", () => {
  const { document } = new Window();
  document.body.innerHTML = `
    <div id="main"><section id="main-approval"></section><textarea id="main-input"></textarea></div>
    <div ${CHAT_SCOPE_ATTR}><section id="side-approval"></section><textarea id="side-input"></textarea></div>`;
  const byId = (id: string) => document.getElementById(id) as unknown as Element;
  assert.equal(sameChatScope(byId("main-approval"), byId("main-input")), true);
  assert.equal(sameChatScope(byId("side-approval"), byId("side-input")), true);
  assert.equal(sameChatScope(byId("main-approval"), byId("side-input")), false);
  assert.equal(sameChatScope(byId("side-approval"), byId("main-input")), false);
  // 焦点不在任何一段里（body、侧栏）算主对话。
  assert.equal(sameChatScope(byId("main-approval"), document.body as unknown as Element), true);
  assert.equal(sameChatScope(byId("side-approval"), null), false);
});
