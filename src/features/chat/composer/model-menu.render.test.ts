import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { act, createElement, createRef, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { createServer, type ViteDevServer } from "vite";
import { fileURLToPath } from "node:url";

import type { AgentKind, AgentModelOption } from "../../../types/index.ts";
import type { AgentChoice } from "./host.ts";

const rootDir = fileURLToPath(new URL("../../../../", import.meta.url));
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
installGlobal("HTMLElement", dom.HTMLElement);
installGlobal("Element", dom.Element);
installGlobal("Node", dom.Node);
installGlobal("navigator", dom.navigator);

let server: ViteDevServer;
let ModelMenu: typeof import("./ModelMenu.tsx").ModelMenu;
let placeComposerMenu: typeof import("./useComposerMenu.ts").placeComposerMenu;

before(async () => {
  server = await createServer({
    root: rootDir,
    configFile: `${rootDir}/vite.config.ts`,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
  });
  ModelMenu = (await server.ssrLoadModule("/src/features/chat/composer/ModelMenu.tsx")).ModelMenu;
  placeComposerMenu = (await server.ssrLoadModule("/src/features/chat/composer/useComposerMenu.ts")).placeComposerMenu;
});

after(async () => {
  await server?.close();
  for (const key of installed) Reflect.deleteProperty(globalThis, key);
  await dom.close();
});

function model(id: string): AgentModelOption {
  return { id, label: id.toUpperCase(), description: "", is_default: false, default_effort: "", efforts: [], show_in_picker: true };
}

const options = [
  { kind: "codex-cli" as AgentKind, name: "Codex CLI", identity: null },
  { kind: "claude-code" as AgentKind, name: "Claude Code", identity: null },
];

function menu(agents: AgentChoice | null, models: AgentModelOption[], picked: AgentModelOption[] = []) {
  return createElement(ModelMenu, {
    menuRef: createRef<HTMLDivElement>() as RefObject<HTMLDivElement>,
    agents,
    models,
    modelId: models[0]?.id,
    fastOn: false,
    fastAvailable: false,
    fastTip: "",
    canReset: false,
    onModel: (next) => picked.push(next),
    onEffort: () => undefined,
    onFast: () => undefined,
    onReset: () => undefined,
  });
}

async function mount(element: ReturnType<typeof menu>) {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root: Root = createRoot(host as unknown as HTMLElement);
  await act(async () => root.render(element));
  return { host, root };
}

function click(host: { querySelector: (selector: string) => unknown }, selector: string) {
  const element = host.querySelector(selector);
  assert.ok(element instanceof dom.HTMLElement, selector);
  element.click();
}

test("the model list sits beside an agent rail; another agent's model switches agent and model", async () => {
  const loaded: AgentKind[] = [];
  const switched: Array<[AgentKind, string]> = [];
  const agents: AgentChoice = {
    options,
    selected: "codex-cli",
    switcher: {
      blocked: null,
      loadModels: async (agent, show) => {
        loaded.push(agent);
        show([model("sonnet")]);
      },
      onPick: (agent, next) => switched.push([agent, next.id]),
    },
  };
  const { host, root } = await mount(menu(agents, [model("gpt")]));
  assert.match(host.textContent ?? "", /GPT/);
  assert.doesNotMatch(host.textContent ?? "", /Codex CLI/);

  await act(async () => click(host, "[data-model-trigger]"));
  const rail = [...host.querySelectorAll("[data-agent-rail] button")].map((button) => button.getAttribute("data-agent"));
  assert.deepEqual(rail, ["codex-cli", "claude-code"]);
  assert.match(host.querySelector("[data-model-list]")?.textContent ?? "", /GPT/);

  await act(async () => click(host, '[data-agent="claude-code"]'));
  assert.deepEqual(loaded, ["claude-code"]);
  const list = host.querySelector("[data-model-list]")?.textContent ?? "";
  assert.doesNotMatch(list, /Claude Code/);
  assert.match(list, /SONNET/);

  await act(async () => click(host, '[data-model-list] [role="option"]'));
  assert.deepEqual(switched, [["claude-code", "sonnet"]]);
  await act(async () => root.unmount());
  host.remove();
});

test("a busy session still lists other agents: stored models show first and cannot be picked", async () => {
  const switched: AgentKind[] = [];
  let finish: () => void = () => undefined;
  let calls = 0;
  const choice = (): AgentChoice => ({
    options,
    selected: "codex-cli",
    switcher: {
      blocked: "当前回合结束后可切换",
      loadModels: (_agent, show) => {
        calls += 1;
        show([model("stored")]);
        return new Promise<void>((resolve) => {
          finish = () => {
            show([model("fresh")]);
            resolve();
          };
        });
      },
      onPick: (agent) => switched.push(agent),
    },
  });
  const { host, root } = await mount(menu(choice(), [model("gpt")]));
  await act(async () => click(host, "[data-model-trigger]"));
  await act(async () => click(host, '[data-agent="claude-code"]'));
  assert.match(host.querySelector("[data-model-list]")?.textContent ?? "", /STORED/);
  assert.match(host.querySelector("[data-switch-blocked]")?.textContent ?? "", /当前回合结束后可切换/);

  // 回合进行中外面不断给新的 switcher，不重读。
  await act(async () => root.render(menu(choice(), [model("gpt")])));
  assert.equal(calls, 1);

  await act(async () => finish());
  assert.match(host.querySelector("[data-model-list]")?.textContent ?? "", /FRESH/);
  await act(async () => click(host, '[data-model-list] [role="option"]'));
  assert.deepEqual(switched, []);
  await act(async () => root.unmount());
  host.remove();
});

test("a session that cannot switch only shows its own agent; no catalog opens straight on the model list", async () => {
  const locked: AgentChoice = { options: [options[0]], selected: "codex-cli", switcher: null };
  const { host, root } = await mount(menu(locked, []));
  const rail = [...host.querySelectorAll("[data-agent-rail] button")].map((button) => button.getAttribute("data-agent"));
  assert.deepEqual(rail, ["codex-cli"]);
  assert.match(host.querySelector("[data-model-list]")?.textContent ?? "", /当前 Agent 没有可选模型/);
  assert.equal(host.querySelector("[data-back-to-effort]"), null);
  await act(async () => root.unmount());
  host.remove();
});

test("model menu widens 276px -> 324px with right-bottom anchoring and effort-aware back label", async () => {
  const withEffort: AgentModelOption = {
    ...model("gpt-5.4"),
    default_effort: "high",
    efforts: [{ id: "high", description: "" }],
  };
  const { host, root } = await mount(menu(null, [withEffort]));
  const popover = host.querySelector("[data-intensity-popover]");
  assert.ok(popover instanceof dom.HTMLElement);
  assert.equal(popover.className.includes("w-[276px]"), true);

  await act(async () => click(host, "[data-model-trigger]"));
  assert.equal(popover.className.includes("w-[324px]"), true);
  assert.equal(host.querySelector("[data-back-to-effort]")?.textContent, "返回强度");

  await act(async () => click(host, "[data-back-to-effort]"));
  assert.equal(popover.className.includes("w-[276px]"), true);
  assert.equal(popover.getAttribute("data-intensity-panel"), "effort");

  // Without reasoning efforts, back button says "返回" rather than "返回强度".
  await act(async () => root.render(menu(null, [model("claude-sonnet")])));
  await act(async () => click(host, "[data-model-trigger]"));
  assert.equal(host.querySelector("[data-back-to-effort]")?.textContent, "返回");

  // Right-bottom anchoring keeps right & bottom fixed across 276px -> 324px.
  Object.defineProperty(dom, "innerWidth", { configurable: true, value: 1280 });
  Object.defineProperty(dom, "innerHeight", { configurable: true, value: 800 });
  const anchor = dom.document.createElement("button") as unknown as HTMLElement;
  anchor.getBoundingClientRect = () =>
    ({ left: 820, right: 900, top: 720, bottom: 748, width: 80, height: 28, x: 820, y: 720, toJSON: () => ({}) }) as DOMRect;
  Object.defineProperty(popover, "offsetWidth", { configurable: true, value: 276 });
  Object.defineProperty(popover, "offsetHeight", { configurable: true, value: 110 });
  placeComposerMenu(anchor, popover as unknown as HTMLElement, "end");
  assert.equal(popover.style.left, "auto");
  assert.equal(popover.style.right, "380px");
  assert.equal(popover.style.bottom, "88px");

  Object.defineProperty(popover, "offsetWidth", { configurable: true, value: 324 });
  Object.defineProperty(popover, "offsetHeight", { configurable: true, value: 220 });
  placeComposerMenu(anchor, popover as unknown as HTMLElement, "end");
  assert.equal(popover.style.right, "380px");
  assert.equal(popover.style.bottom, "88px");

  await act(async () => root.unmount());
  host.remove();
});
