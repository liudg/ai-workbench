import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { act, createElement, createRef, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { createServer, type ViteDevServer } from "vite";
import { fileURLToPath } from "node:url";

import type { AgentChoice } from "../chat/index.ts";
import type { AgentKind, AgentModelOption } from "../../types/index.ts";

const rootDir = fileURLToPath(new URL("../../../", import.meta.url));
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
let ModelMenu: typeof import("../chat/composer/ModelMenu.tsx").ModelMenu;

before(async () => {
  server = await createServer({
    root: rootDir,
    configFile: `${rootDir}/vite.config.ts`,
    server: { middlewareMode: true, hmr: false, ws: false },
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
  return {
    id,
    label: id.toUpperCase(),
    description: "",
    is_default: false,
    default_effort: "",
    efforts: [],
    show_in_picker: true,
  };
}

async function mountMenu(agents: AgentChoice, models: AgentModelOption[]) {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root: Root = createRoot(host as unknown as HTMLElement);
  await act(async () => {
    root.render(
      createElement(ModelMenu, {
        menuRef: createRef<HTMLDivElement>() as RefObject<HTMLDivElement>,
        agents,
        models,
        modelId: models[0]?.id,
        fastOn: false,
        fastAvailable: false,
        fastTip: "",
        canReset: false,
        onModel: () => undefined,
        onEffort: () => undefined,
        onFast: () => undefined,
        onReset: () => undefined,
      }),
    );
  });
  return { host, root };
}

function click(host: { querySelector: (selector: string) => unknown }, selector: string) {
  const element = host.querySelector(selector);
  assert.ok(element instanceof dom.HTMLElement, `expected ${selector}`);
  element.click();
}

test("ModelMenu distinguishes two instances of the same AgentKind, renders accent dot & displayName, and switches cleanly", async () => {
  const selectedCalls: Array<unknown[]> = [];
  const loadedCalls: Array<[AgentKind, string | undefined]> = [];
  const pickedCalls: Array<[AgentKind, string, string | undefined]> = [];

  const choice: AgentChoice = {
    options: [
      {
        kind: "codex-cli",
        instanceId: "codex-cli",
        name: "Codex 个人",
        isDefault: true,
        identity: { name: "Codex 个人", icon: null },
      },
      {
        kind: "codex-cli",
        instanceId: "codex-work",
        name: "Codex 工作网关",
        accentColor: "#10b981",
        isDefault: false,
        identity: { name: "Codex 工作网关", icon: null, accentColor: "#10b981" },
      },
      {
        kind: "claude-code",
        name: "Claude Code",
        identity: null,
      },
    ],
    selected: "codex-cli",
    selectedInstanceId: "codex-cli",
    selectAgent: (...args) => selectedCalls.push(args),
    switcher: {
      blocked: null,
      loadModels: async (agent, show, instanceId) => {
        loadedCalls.push([agent, instanceId]);
        if (instanceId === "codex-work") show([model("gpt-gateway")]);
        else show([model("claude-opus")]);
      },
      onPick: (agent, picked, instanceId) => pickedCalls.push([agent, picked.id, instanceId]),
    },
  };

  const { host, root } = await mountMenu(choice, [model("gpt-personal")]);
  try {
    await act(async () => click(host, "[data-model-trigger]"));

    const railButtons = [...host.querySelectorAll("[data-agent-rail] button")];
    assert.deepEqual(
      railButtons.map((btn) => ({
        instance: btn.getAttribute("data-instance"),
        pressed: btn.getAttribute("aria-pressed"),
        dot: Boolean(btn.querySelector("[data-instance-dot]")),
      })),
      [
        { instance: "codex-cli", pressed: "true", dot: false },
        { instance: "codex-work", pressed: "false", dot: true },
        { instance: "claude-code", pressed: "false", dot: false },
      ],
    );

    // Instance strip shows both Codex instances' display names
    const stripText = host.querySelector("[data-instance-strip]")?.textContent ?? "";
    assert.match(stripText, /Codex 个人/);
    assert.match(stripText, /Codex 工作网关/);

    // Click second instance of the SAME AgentKind ("codex-work")
    await act(async () => click(host, '[data-instance="codex-work"]'));
    assert.deepEqual(selectedCalls, [["codex-cli", "codex-work"]]);
    assert.deepEqual(loadedCalls, [["codex-cli", "codex-work"]]);
    assert.match(host.querySelector("[data-model-list]")?.textContent ?? "", /GPT-GATEWAY/);

    // Pick model under "codex-work"
    await act(async () => click(host, '[data-model-list] [role="option"]'));
    assert.deepEqual(pickedCalls, [["codex-cli", "gpt-gateway", "codex-work"]]);

    // Legacy option without explicit instanceId keeps single-arg selectAgent(agent) signature
    await act(async () => click(host, '[data-instance="claude-code"]'));
    assert.deepEqual(selectedCalls[1], ["claude-code"]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
