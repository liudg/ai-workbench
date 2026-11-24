import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Window } from "happy-dom";

import { buildWhenContext, detectFocusContext } from "./context.ts";

const dom = new Window({ url: "http://localhost/" });
const installed: PropertyKey[] = [];

function installGlobal(key: string, value: unknown) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
  if (descriptor && !descriptor.configurable && !descriptor.writable) return;
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  installed.push(key);
}

before(() => {
  installGlobal("window", dom);
  installGlobal("document", dom.document);
});

after(async () => {
  for (const key of installed) Reflect.deleteProperty(globalThis, key);
  await dom.close();
});

test("detectFocusContext treats target: null as explicit null without falling back to document.activeElement", () => {
  const input = dom.document.createElement("input");
  input.type = "text";
  dom.document.body.appendChild(input);
  input.focus();
  assert.equal(dom.document.activeElement, input);

  try {
    // undefined target falls back to document.activeElement
    assert.deepEqual(detectFocusContext(undefined), {
      terminalFocus: false,
      composerFocus: false,
      inputFocus: true,
    });

    // explicit null target must NOT fall back to document.activeElement
    assert.deepEqual(detectFocusContext(null), {
      terminalFocus: false,
      composerFocus: false,
      inputFocus: false,
    });
    const ctx = buildWhenContext({ target: null, panelOpen: true });
    assert.equal(ctx.inputFocus, false);
    assert.equal(ctx.composerFocus, false);
    assert.equal(ctx.terminalFocus, false);
  } finally {
    input.remove();
  }
});

test("detectFocusContext sets composerFocus/inputFocus only for editable elements inside .composer-root, not buttons", () => {
  const composerRoot = dom.document.createElement("div");
  composerRoot.className = "composer-root";

  const textarea = dom.document.createElement("textarea");
  const button = dom.document.createElement("button");
  button.type = "button";
  composerRoot.appendChild(textarea);
  composerRoot.appendChild(button);
  dom.document.body.appendChild(composerRoot);

  try {
    assert.deepEqual(detectFocusContext(textarea as unknown as EventTarget), {
      terminalFocus: false,
      composerFocus: true,
      inputFocus: true,
    });

    button.focus();
    assert.deepEqual(detectFocusContext(button as unknown as EventTarget), {
      terminalFocus: false,
      composerFocus: false,
      inputFocus: false,
    });
    assert.deepEqual(detectFocusContext(), {
      terminalFocus: false,
      composerFocus: false,
      inputFocus: false,
    });
  } finally {
    composerRoot.remove();
  }
});
