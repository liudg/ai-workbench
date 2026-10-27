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

before(async () => {
  server = await createServer({
    root: rootDir,
    configFile: `${rootDir}/vite.config.ts`,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
  });
  ModelMenu = (await server.ssrLoadModule("/src/features/chat/composer/ModelMenu.tsx")).ModelMenu;
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
      loadModels: async (agent) => {
        loaded.push(agent);
        return [model("sonnet")];
      },
      onPick: (agent, next) => switched.push([agent, next.id]),
    },
  };
  const { host, root } = await mount(menu(agents, [model("gpt")]));
  assert.match(host.textContent ?? "", /Codex CLI · GPT/);

  await act(async () => click(host, "[data-model-trigger]"));
  const rail = [...host.querySelectorAll("[data-agent-rail] button")].map((button) => button.getAttribute("data-agent"));
  assert.deepEqual(rail, ["codex-cli", "claude-code"]);
  assert.match(host.querySelector("[data-model-list]")?.textContent ?? "", /GPT/);

  await act(async () => click(host, '[data-agent="claude-code"]'));
  assert.deepEqual(loaded, ["claude-code"]);
  const list = host.querySelector("[data-model-list]")?.textContent ?? "";
  assert.match(list, /Claude Code/);
  assert.match(list, /SONNET/);

  await act(async () => click(host, '[data-model-list] [role="option"]'));
  assert.deepEqual(switched, [["claude-code", "sonnet"]]);
  await act(async () => root.unmount());
  host.remove();
});

test("a started session only shows its own agent; no catalog opens straight on the model list", async () => {
  const locked: AgentChoice = { options: [options[0]], selected: "codex-cli", switcher: null };
  const { host, root } = await mount(menu(locked, []));
  const rail = [...host.querySelectorAll("[data-agent-rail] button")].map((button) => button.getAttribute("data-agent"));
  assert.deepEqual(rail, ["codex-cli"]);
  assert.match(host.querySelector("[data-model-list]")?.textContent ?? "", /当前 Agent 没有可选模型/);
  await act(async () => root.unmount());
  host.remove();
});
