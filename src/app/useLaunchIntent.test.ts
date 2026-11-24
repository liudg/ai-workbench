import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { act, createElement, StrictMode } from "react";
import type { createRoot as CreateRoot, Root } from "react-dom/client";
import { Window } from "happy-dom";
import { createServer, type ViteDevServer } from "vite";
import { fileURLToPath } from "node:url";

import type { LaunchIntent } from "../lib/native/launch.ts";
import type { MainView } from "../shared/shell/navigation.ts";

const rootDir = fileURLToPath(new URL("../../", import.meta.url));
const dom = new Window({ url: "http://localhost/" });
const installed: PropertyKey[] = [];

function installGlobal(key: string, value: unknown) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
  if (descriptor && !descriptor.configurable && !descriptor.writable) return;
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  installed.push(key);
}

installGlobal("IS_REACT_ACT_ENVIRONMENT", true);
installGlobal("window", dom);
installGlobal("document", dom.document);
installGlobal("localStorage", dom.localStorage);
installGlobal("HTMLElement", dom.HTMLElement);
installGlobal("Element", dom.Element);
installGlobal("Node", dom.Node);
installGlobal("navigator", dom.navigator);

let server: ViteDevServer;
let createRoot: typeof CreateRoot;
let useLaunchIntent: typeof import("./useLaunchIntent.ts").useLaunchIntent;
let navMod: typeof import("../shared/shell/navigation.ts");
let errorMod: typeof import("../shared/shell/error-banner.ts");
let draftsMod: typeof import("../features/workspace/session/composer-drafts.ts");
let daemonMod: typeof import("../lib/daemon/index.ts");

before(async () => {
  ({ createRoot } = await import("react-dom/client"));
  server = await createServer({
    root: rootDir,
    configFile: `${rootDir}/vite.config.ts`,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    logLevel: "error",
  });
  daemonMod = (await server.ssrLoadModule("/src/lib/daemon/index.ts")) as typeof daemonMod;
  daemonMod.daemon.disable("unit-test");
  daemonMod.daemon.call = (async (method: string) => {
    if (method === "drafts.get") return null;
    if (method === "drafts.set") return null;
    if (method === "projects.list") return [];
    return null;
  }) as typeof daemonMod.daemon.call;

  navMod = (await server.ssrLoadModule("/src/shared/shell/navigation.ts")) as typeof navMod;
  errorMod = (await server.ssrLoadModule("/src/shared/shell/error-banner.ts")) as typeof errorMod;
  draftsMod = (await server.ssrLoadModule(
    "/src/features/workspace/session/composer-drafts.ts",
  )) as typeof draftsMod;
  ({ useLaunchIntent } = (await server.ssrLoadModule(
    "/src/app/useLaunchIntent.ts",
  )) as typeof import("./useLaunchIntent.ts"));
});

after(async () => {
  await server?.close();
  for (const key of installed) Reflect.deleteProperty(globalThis, key);
  await dom.close();
});

test("useLaunchIntent survives StrictMode remount, redrains mid-drain arrivals, and rejects hidden-only prompts before navigating", async () => {
  navMod.openSettings();
  errorMod.clearError();

  // Pre-seed existing draft on standalone new:chat so overwrite confirmation is triggered
  draftsMod.patchDraft("new:chat", {
    text: "已有未发送草稿",
    files: [],
    snippets: [],
  });

  let arrivalHandler = null as (() => void) | null;
  let drainCount = 0;
  let resolveFirstDrain = null as ((items: LaunchIntent[]) => void) | null;

  const drain = () => {
    drainCount += 1;
    if (drainCount === 1) {
      return new Promise<LaunchIntent[]>((resolve) => {
        resolveFirstDrain = resolve;
      });
    }
    if (drainCount === 2) {
      return Promise.resolve<LaunchIntent[]>([
        { kind: "newPrompt", prompt: "外部新提示词\u200B" },
      ]);
    }
    return Promise.resolve<LaunchIntent[]>([
      { kind: "newPrompt", prompt: "\u200B\u202E\uFEFF" },
    ]);
  };

  const listen = (onArrival: () => void) => {
    arrivalHandler = onArrival;
    return () => {
      if (arrivalHandler === onArrival) arrivalHandler = null;
    };
  };

  let latestState = null as ReturnType<typeof useLaunchIntent> | null;
  let latestNav = null as { view: MainView; settings: boolean } | null;
  let latestError = null as string | null;

  function Probe() {
    latestState = useLaunchIntent({ drain, listen });
    const view = navMod.useNavigation((s) => s.view);
    const settings = navMod.useNavigation((s) => s.settings);
    latestNav = { view, settings };
    latestError = errorMod.useErrorBanner();
    return null;
  }

  const host = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.appendChild(host as unknown as Parameters<typeof dom.document.body.appendChild>[0]);
  const root: Root = createRoot(host);

  try {
    await act(async () => {
      root.render(createElement(StrictMode, null, createElement(Probe)));
    });
    assert.equal(drainCount, 1);
    assert.equal(latestNav?.settings, true);

    // Fire warm wakeup WHILE first drain is still in flight -> sets needsRedrain = true
    arrivalHandler?.();

    // Resolve first drain (empty) -> triggers automatic second drain which delivers overwrite prompt to StrictMode Mount #2!
    await act(async () => {
      resolveFirstDrain?.([]);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    assert.equal(drainCount, 2);
    assert.equal(latestNav?.settings, false);
    assert.equal(latestNav?.view.kind, "new");
    assert.equal(latestState?.overwritePrompt?.incomingPrompt, "外部新提示词");
    assert.equal(latestState?.overwritePrompt?.hiddenCharactersRemoved, 1);

    // Confirm overwrite on Mount #2 -> writes draft and surfaces hidden-character warning on Mount #2
    await act(async () => {
      latestState?.confirmOverwrite();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(draftsMod.readDraft("new:chat").text, "外部新提示词");
    assert.match(latestState?.warning ?? "", /移除了 1 个隐藏字符/);

    // Switch back to settings and send a hidden-only prompt -> rejected BEFORE openNewSession!
    await act(async () => {
      navMod.openSettings();
    });
    assert.equal(latestNav?.settings, true);
    await act(async () => {
      arrivalHandler?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(latestNav?.settings, true);
    assert.match(latestError ?? "", /仅包含隐藏字符/);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("whitespace-only prompt does not abort directory or named-project navigation, while bare whitespace newPrompt is ignored", async () => {
  // Record lastTask for proj-alpha so openProject restores task-alpha-1, then switch to settings
  navMod.openTask("task-alpha-1", "proj-alpha");
  navMod.openSettings();
  errorMod.clearError();

  const origCall = daemonMod.daemon.call.bind(daemonMod.daemon);
  daemonMod.daemon.call = (async (method: string) => {
    if (method === "projects.list") {
      return [
        {
          id: "proj-alpha",
          name: "Alpha",
          path: "G:\\workspace\\alpha",
          folders: [],
          createdAt: 1,
          updatedAt: 1,
        },
      ];
    }
    if (method === "tasks.list") {
      return [{ id: "task-alpha-1", projectId: "proj-alpha", archivedAt: undefined }];
    }
    if (method === "drafts.get" || method === "drafts.set") return null;
    return null;
  }) as typeof daemonMod.daemon.call;

  const queue: LaunchIntent[][] = [
    // 1) Bare newPrompt with whitespace-only prompt and no project -> ignored (stays on settings, no error)
    [{ kind: "newPrompt", prompt: "   \t\n  " }],
    // 2) directory intent with whitespace-only prompt -> proceeds to open directory project (task-alpha-1)
    [{ kind: "directory", path: "G:\\workspace\\alpha", prompt: "   " }],
    // 3) named-project newPrompt with whitespace-only prompt -> opens new session in proj-alpha
    [{ kind: "newPrompt", project: "Alpha", prompt: "   " }],
  ];

  let arrivalHandler = null as (() => void) | null;
  const drain = () => Promise.resolve(queue.shift() ?? []);
  const listen = (onArrival: () => void) => {
    arrivalHandler = onArrival;
    return () => {
      if (arrivalHandler === onArrival) arrivalHandler = null;
    };
  };

  let latestNav = null as { view: MainView; settings: boolean } | null;
  let latestError = null as string | null;

  function Probe() {
    useLaunchIntent({ drain, listen });
    const view = navMod.useNavigation((s) => s.view);
    const settings = navMod.useNavigation((s) => s.settings);
    latestNav = { view, settings };
    latestError = errorMod.useErrorBanner();
    return null;
  }

  const host = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.appendChild(host as unknown as Parameters<typeof dom.document.body.appendChild>[0]);
  const root: Root = createRoot(host);

  try {
    // Drain #1: bare whitespace newPrompt -> ignored
    await act(async () => {
      root.render(createElement(Probe));
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(latestNav?.settings, true);
    assert.equal(latestError, null);

    // Drain #2: directory + whitespace prompt -> navigates to project task without error
    await act(async () => {
      arrivalHandler?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(latestNav?.settings, false);
    assert.deepEqual(latestNav?.view, { kind: "task", taskId: "task-alpha-1", projectId: "proj-alpha" });
    assert.equal(latestError, null);

    // Drain #3: named-project + whitespace prompt -> opens new session in proj-alpha
    await act(async () => {
      arrivalHandler?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.deepEqual(latestNav?.view, { kind: "new", projectId: "proj-alpha" });
    assert.equal(latestError, null);
  } finally {
    daemonMod.daemon.call = origCall;
    await act(async () => root.unmount());
    host.remove();
  }
});
