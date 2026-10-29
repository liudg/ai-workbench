import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { act, createElement } from "react";
import type { createRoot as CreateRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { createServer, type ViteDevServer } from "vite";
import { fileURLToPath } from "node:url";

const dom = new Window({ url: "http://localhost/" });
const frames = new Map<number, FrameRequestCallback>();
let frameId = 0;
for (const [key, value] of [
  ["window", dom],
  ["document", dom.document],
  ["HTMLElement", dom.HTMLElement],
  ["Element", dom.Element],
  ["Node", dom.Node],
  ["navigator", dom.navigator],
  ["MutationObserver", dom.MutationObserver],
  ["IS_REACT_ACT_ENVIRONMENT", true],
  ["requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  }],
  ["cancelAnimationFrame", (id: number) => frames.delete(id)],
] as const) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

let server: ViteDevServer;
let createRoot: typeof CreateRoot;
let findMod: typeof import("./use-thread-find.ts");
let barMod: typeof import("./FindBar.tsx");
let followMod: typeof import("../timeline/useTimelineFollow.ts");
let hostMod: typeof import("../host.tsx");

before(async () => {
  ({ createRoot } = await import("react-dom/client"));
  const rootDir = fileURLToPath(new URL("../../../../", import.meta.url));
  server = await createServer({
    root: rootDir,
    configFile: `${rootDir}/vite.config.ts`,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
  });
  findMod = await server.ssrLoadModule("/src/features/chat/find/use-thread-find.ts") as typeof findMod;
  barMod = await server.ssrLoadModule("/src/features/chat/find/FindBar.tsx") as typeof barMod;
  followMod = await server.ssrLoadModule("/src/features/chat/timeline/useTimelineFollow.ts") as typeof followMod;
  hostMod = await server.ssrLoadModule("/src/features/chat/host.tsx") as typeof hostMod;
});

after(async () => {
  await server?.close();
  await dom.close();
});

async function flushFrames() {
  await act(async () => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
  });
}

async function renderFind(texts: string[]) {
  let follow: ReturnType<typeof followMod.useTimelineFollow>;
  function Harness({ revision }: { revision: number }) {
    follow = followMod.useTimelineFollow("find-test", String(revision));
    const find = findMod.useThreadFind(follow.scrollRef, String(revision), follow.holdScrollPosition);
    return createElement("div", null,
      find.open ? createElement(barMod.FindBar, { ...find, onClose: find.close }) : null,
      createElement("div", { ref: follow.scrollRef, onScroll: follow.onTimelineScroll },
        createElement("div", { ref: follow.contentRef },
          texts.map((text, index) => createElement("p", { key: index }, text)),
        ),
      ),
    );
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  async function render(revision: number) {
    await act(async () => root.render(createElement(hostMod.ChatHostProvider, {
      host: { profiles: {}, projectPath: "", answerPrompt: async () => false },
      children: createElement(Harness, { revision }),
    })));
  }
  await render(0);
  const scroller = follow!.scrollRef.current!;
  Object.defineProperties(scroller, {
    clientHeight: { configurable: true, value: 300 },
    scrollHeight: { configurable: true, value: 2000 },
  });
  scroller.getBoundingClientRect = () => new dom.DOMRect(0, 0, 600, 300) as DOMRect;
  let visible = false;
  const scrolls: HTMLElement[] = [];
  const originalRect = dom.HTMLElement.prototype.getBoundingClientRect;
  const originalScroll = dom.HTMLElement.prototype.scrollIntoView;
  dom.HTMLElement.prototype.getBoundingClientRect = function () {
    return new dom.DOMRect(0, visible ? 120 : 900, 80, 24);
  };
  dom.HTMLElement.prototype.scrollIntoView = function (options) {
    const mark = this as unknown as HTMLElement;
    assert.equal(mark.isConnected, true);
    assert.equal(mark.dataset.threadFindMark, "current");
    assert.equal(typeof options === "object" ? options.block : undefined, "center");
    scrolls.push(mark);
    scroller.scrollTop = 700;
  };

  return {
    host, scroller, scrolls, render,
    get follow() { return follow!; },
    setVisible(value: boolean) { visible = value; },
    async open(query: string) {
      await act(async () => dom.dispatchEvent(new dom.CustomEvent(findMod.OPEN_THREAD_FIND, { detail: { query } })));
      await flushFrames();
      await flushFrames();
    },
    async key(key: string, shiftKey = false) {
      const input = host.querySelector("input")!;
      await act(async () => input.dispatchEvent(new dom.KeyboardEvent("keydown", { key, shiftKey, bubbles: true }) as unknown as KeyboardEvent));
      await flushFrames();
      await flushFrames();
    },
    async close() {
      await act(async () => root.unmount());
      host.remove();
      frames.clear();
      dom.HTMLElement.prototype.getBoundingClientRect = originalRect;
      dom.HTMLElement.prototype.scrollIntoView = originalScroll;
    },
  };
}

test("Enter and Shift+Enter reveal the current connected mark and wrap without losing focus", async () => {
  const view = await renderFind(["装备一", "装备二", "装备三"]);
  try {
    await view.open("装备");
    assert.equal(view.scrolls.length, 1);
    for (const [shift, expected] of [[false, 2], [false, 3], [false, 1], [true, 3]] as const) {
      await view.key("Enter", shift);
      assert.equal(view.host.querySelector("[data-thread-find-status]")?.textContent, `${expected}/3`);
      assert.equal(view.scrolls[view.scrolls.length - 1]?.parentElement?.textContent, ["装备一", "装备二", "装备三"][expected - 1]);
      assert.equal(document.activeElement, view.host.querySelector("input"));
    }
    assert.equal(view.scrolls.length, 5);
    view.setVisible(true);
    await view.key("Enter");
    assert.equal(view.scrolls.length, 5, "a visible match should not move the viewport");
  } finally {
    await view.close();
  }
});

test("a single match can be located repeatedly, and updates or closing do not pull it to the bottom", async () => {
  const view = await renderFind(["唯一装备"]);
  try {
    await view.open("装备");
    for (const shift of [false, true]) {
      view.scroller.scrollTop = 0;
      await view.key("Enter", shift);
      assert.equal(view.scroller.scrollTop, 700);
      assert.equal(view.host.querySelector("[data-thread-find-status]")?.textContent, "1/1");
    }
    assert.equal(view.scrolls.length, 3);
    assert.equal(view.follow.followRef.current, false);
    assert.equal(view.follow.anchorTopRef.current, 700);
    assert.equal(view.follow.distanceRef.current, 1000);
    await view.render(1);
    await flushFrames();
    assert.equal(view.scrolls.length, 3, "layout changes should not navigate again");
    assert.equal(view.scroller.scrollTop, 700);
    await view.key("Escape");
    assert.equal(view.host.querySelector("mark"), null);
    assert.equal(view.scroller.scrollTop, 700);
    await view.open("装备");
    assert.equal(view.scrolls.length, 4, "reopening should reveal the match again");
  } finally {
    await view.close();
  }
});

test("new matches update the count without navigating, and an empty search cancels a pending jump", async () => {
  const texts = ["装备一"];
  const view = await renderFind(texts);
  try {
    await view.open("装备");
    texts.push("装备二");
    await view.render(1);
    await flushFrames();
    assert.equal(view.host.querySelector("[data-thread-find-status]")?.textContent, "1/2");
    assert.equal(view.scrolls.length, 1);
    assert.equal(view.scroller.scrollTop, 700);

    await act(async () => view.host.querySelector("input")!.dispatchEvent(
      new dom.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as KeyboardEvent,
    ));
    await view.open("不存在");
    assert.equal(view.scrolls.length, 1);
    assert.equal(view.host.querySelector("mark"), null);
    await view.key("Enter");
    assert.equal(view.scrolls.length, 1);
  } finally {
    await view.close();
  }
});
