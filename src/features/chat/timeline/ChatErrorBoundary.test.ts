import assert from "node:assert/strict";
import { after, test } from "node:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";

import { ChatErrorBoundary } from "./ChatErrorBoundary.ts";

const dom = new Window({ url: "http://localhost/" });
for (const [key, value] of [
  ["window", dom],
  ["document", dom.document],
  ["HTMLElement", dom.HTMLElement],
  ["Element", dom.Element],
  ["Node", dom.Node],
  ["navigator", dom.navigator],
  ["IS_REACT_ACT_ENVIRONMENT", true],
] as const) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

function Boom({ fail }: { fail: boolean }) {
  if (fail) throw new Error("findings");
  return createElement("p", null, "可见");
}

test("a thrown timeline stays inside the session and clears on the next session", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root: Root = createRoot(host);
  await act(async () => {
    root.render(
      createElement(ChatErrorBoundary, {
        resetKey: "s1",
        children: createElement(Boom, { fail: true }),
      }),
    );
  });
  assert.match(host.textContent ?? "", /这条会话暂时无法显示/);
  await act(async () => {
    root.render(
      createElement(ChatErrorBoundary, {
        resetKey: "s2",
        children: createElement(Boom, { fail: false }),
      }),
    );
  });
  assert.match(host.textContent ?? "", /可见/);
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

after(() => {
  dom.close();
});
