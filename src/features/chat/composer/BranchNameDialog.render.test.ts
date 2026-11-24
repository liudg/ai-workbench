import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { createServer, type ViteDevServer } from "vite";

const dom = new Window({ url: "http://localhost/" });
const globals = {
  IS_REACT_ACT_ENVIRONMENT: true,
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  HTMLElement: dom.HTMLElement,
  HTMLInputElement: dom.HTMLInputElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  HTMLTextAreaElement: dom.HTMLTextAreaElement,
  Element: dom.Element,
  Node: dom.Node,
  NodeFilter: dom.NodeFilter,
  SVGElement: dom.SVGElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
  PointerEvent: dom.PointerEvent,
  MutationObserver: dom.MutationObserver,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
};
const descriptors = new Map(
  Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

let server: ViteDevServer;
let BranchNameDialog: typeof import("./BranchNameDialog.tsx").BranchNameDialog;
let navigation: typeof import("../../../shared/shell/navigation.ts");
let daemonMod: typeof import("../../../lib/daemon/index.ts");

before(async () => {
  const rootDir = fileURLToPath(new URL("../../../../", import.meta.url));
  server = await createServer({
    root: rootDir,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    logLevel: "error",
  });
  BranchNameDialog = (await server.ssrLoadModule("/src/features/chat/composer/BranchNameDialog.tsx"))
    .BranchNameDialog;
  navigation = (await server.ssrLoadModule(
    "/src/shared/shell/navigation.ts",
  )) as typeof navigation;
  daemonMod = (await server.ssrLoadModule("/src/lib/daemon/index.ts")) as typeof daemonMod;
});

after(async () => {
  await server?.close();
  await dom.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test("BranchNameDialog AI suggest button fills input for review and submits confirmed branch", async () => {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  const submitted: string[] = [];
  const suggestCalls: string[] = [];

  try {
    await act(async () => {
      root.render(
        createElement(BranchNameDialog, {
          open: true,
          title: "创建并检出新分支",
          initialName: "aiwb/",
          submitLabel: "创建",
          busyLabel: "正在创建…",
          busy: false,
          error: null,
          dataAttr: "data-test-branch-dialog",
          onCancel: () => {},
          onSubmit: (name) => submitted.push(name),
          onSuggestBranch: async (current) => {
            suggestCalls.push(current);
            return "feat/timeline-rewind";
          },
        }),
      );
    });

    const dialog = dom.document.body.querySelector("[data-test-branch-dialog]")!;
    const suggestBtn = dialog.querySelector("[data-branch-ai-suggest]") as unknown as HTMLButtonElement;
    assert.ok(suggestBtn);
    assert.match(suggestBtn.textContent ?? "", /AI 生成/);

    await act(async () => suggestBtn.click());
    assert.deepEqual(suggestCalls, ["aiwb/"]);

    const input = dialog.querySelector("input") as unknown as HTMLInputElement;
    assert.equal(input.value, "feat/timeline-rewind");
    assert.deepEqual(submitted, [], "AI suggestion only fills input without auto-submitting");

    const form = dialog.querySelector("form")!;
    await act(async () => {
      form.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }));
    });
    assert.deepEqual(submitted, ["feat/timeline-rewind"]);
  } finally {
    await act(async () => root.unmount());
    await new Promise((resolve) => setTimeout(resolve, 20));
    host.remove();
  }
});

test("BranchNameDialog default AI suggestion calls textGen.branchName with active taskId and projectId", async () => {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  const originalCall = daemonMod.daemon.call;
  const rpcCalls: { method: string; params: unknown }[] = [];

  try {
    daemonMod.daemon.call = (async (method: string, params: unknown) => {
      rpcCalls.push({ method, params });
      if (method === "textGen.branchName") {
        return { branch: "fix/search-hit-jump" };
      }
      throw new Error(`Unexpected RPC: ${method}`);
    }) as typeof daemonMod.daemon.call;

    navigation.openTask("task-99", "proj-7");

    await act(async () => {
      root.render(
        createElement(BranchNameDialog, {
          open: true,
          title: "创建并检出新分支",
          initialName: "",
          submitLabel: "创建",
          busyLabel: "正在创建…",
          busy: false,
          error: null,
          dataAttr: "data-test-default-branch",
          onCancel: () => {},
          onSubmit: () => {},
        }),
      );
    });

    const dialog = dom.document.body.querySelector("[data-test-default-branch]")!;
    await act(async () => (dialog.querySelector("[data-branch-ai-suggest]") as unknown as HTMLButtonElement).click());

    assert.deepEqual(rpcCalls, [
      {
        method: "textGen.branchName",
        params: { prompt: "", taskId: "task-99", projectId: "proj-7" },
      },
    ]);
    assert.equal((dialog.querySelector("input") as unknown as HTMLInputElement).value, "fix/search-hit-jump");

    // Clicking AI suggest a second time without manual edits must NOT feed the previous AI branch slug as prompt
    await act(async () => (dialog.querySelector("[data-branch-ai-suggest]") as unknown as HTMLButtonElement).click());
    assert.deepEqual(rpcCalls[1], {
      method: "textGen.branchName",
      params: { prompt: "", taskId: "task-99", projectId: "proj-7" },
    });
  } finally {
    daemonMod.daemon.call = originalCall;
    daemonMod.daemon.stop();
    await act(async () => root.unmount());
    await new Promise((resolve) => setTimeout(resolve, 20));
    host.remove();
  }
});
