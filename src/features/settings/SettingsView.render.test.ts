import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { act, createElement } from "react";
import type { createRoot as CreateRoot, Root } from "react-dom/client";
import { Window } from "happy-dom";
import { createServer, type ViteDevServer } from "vite";
import { fileURLToPath } from "node:url";

import {
  type AgentCapabilities,
  type AgentInstallation,
  type AgentInstance,
  type AgentProfile,
  type TextGenSettings,
} from "../../types/index.ts";
import type { UpsertInstanceInput } from "../agents/index.ts";

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
installGlobal("localStorage", dom.localStorage);
installGlobal("HTMLElement", dom.HTMLElement);
installGlobal("HTMLButtonElement", dom.HTMLButtonElement);
installGlobal("HTMLInputElement", dom.HTMLInputElement);
installGlobal("HTMLSelectElement", dom.HTMLSelectElement);
installGlobal("HTMLTextAreaElement", dom.HTMLTextAreaElement);
installGlobal("SVGElement", dom.SVGElement);
installGlobal("Element", dom.Element);
installGlobal("Node", dom.Node);
installGlobal("navigator", dom.navigator);
installGlobal("MutationObserver", dom.MutationObserver);
installGlobal("NodeFilter", dom.NodeFilter);
installGlobal("CustomEvent", dom.CustomEvent);
installGlobal("PointerEvent", dom.PointerEvent);
installGlobal("MouseEvent", dom.MouseEvent);
installGlobal("KeyboardEvent", dom.KeyboardEvent);
installGlobal("FocusEvent", dom.FocusEvent);
installGlobal("getComputedStyle", dom.getComputedStyle.bind(dom));
installGlobal("requestAnimationFrame", dom.requestAnimationFrame.bind(dom));
installGlobal("cancelAnimationFrame", dom.cancelAnimationFrame.bind(dom));
installGlobal("matchMedia", dom.matchMedia.bind(dom));

let server: ViteDevServer;
let createRoot: typeof CreateRoot;
let SettingsView: typeof import("./SettingsView.tsx").SettingsView;
let InstanceFormDialog: typeof import("./InstanceFormDialog.tsx").InstanceFormDialog;
let agentsMod: typeof import("../agents/index.ts");
let daemonMod: typeof import("../../lib/daemon/index.ts");

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
  daemonMod.startPreview({});
  agentsMod = (await server.ssrLoadModule("/src/features/agents/index.ts")) as typeof agentsMod;
  SettingsView = (await server.ssrLoadModule("/src/features/settings/SettingsView.tsx"))
    .SettingsView;
  InstanceFormDialog = (
    await server.ssrLoadModule("/src/features/settings/InstanceFormDialog.tsx")
  ).InstanceFormDialog;
});

after(async () => {
  await server?.close();
  for (const key of installed) Reflect.deleteProperty(globalThis, key);
  await dom.close();
});

function fullCaps(overrides: Partial<AgentCapabilities> = {}): AgentCapabilities {
  return {
    supports_slash: true,
    supports_resume: true,
    supports_questions: true,
    supports_tuning: true,
    supports_skills: true,
    changes: { turn_diff: true, per_file_patch: true, git_scopes: true },
    supports_multi_instance: true,
    supports_text_generation: true,
    ...overrides,
  };
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new dom.InputEvent("input", { bubbles: true }) as unknown as Event);
}

test("InstanceFormDialog gates shadowHome on capabilities and preserves redacted env secrets on submit", async () => {
  const submitted: UpsertInstanceInput[] = [];
  const existing: AgentInstance = {
    id: "claude-work",
    kind: "claude-code",
    displayName: "Claude 工作号",
    accentColor: "#10b981",
    binaryPath: null,
    launchArgs: ["--fast"],
    environment: [
      {
        name: "ANTHROPIC_API_KEY",
        value: "",
        sensitive: true,
        valueRedacted: true,
      },
    ],
    isolationMode: "isolatedHome",
    homePath: null,
    sharedHomePath: null,
    enabled: true,
    isDefault: false,
    sortOrder: 100,
    createdAt: 10,
    updatedAt: 10,
  };

  const host = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.appendChild(host as unknown as Parameters<typeof dom.document.body.appendChild>[0]);
  const root: Root = createRoot(host);

  try {
    // 1) supports_shadow_home = false -> no shadowHome option
    await act(async () => {
      root.render(
        createElement(InstanceFormDialog, {
          open: true,
          kind: "claude-code",
          agentLabel: "Claude Code",
          instance: existing,
          capabilities: fullCaps({ supports_shadow_home: false }),
          onClose: () => undefined,
          onSubmit: async (input) => {
            submitted.push(input);
          },
        }),
      );
    });

    assert.ok(dom.document.querySelector('[data-instance-isolation="hostDefault"]'));
    assert.ok(dom.document.querySelector('[data-instance-isolation="isolatedHome"]'));
    assert.equal(dom.document.querySelector('[data-instance-isolation="shadowHome"]'), null);

    // Redacted env input starts with empty value so placeholder renders cleanly
    const envValueInput = dom.document.querySelector(
      '[data-instance-env-value="0"]',
    ) as unknown as HTMLInputElement;
    assert.equal(envValueInput.value, "");
    assert.equal(envValueInput.placeholder, "已保存密钥（输入新值覆盖）");

    // Rename without touching secret -> submits empty value + valueRedacted: true
    const nameInput = dom.document.querySelector("[data-instance-name]") as unknown as HTMLInputElement;
    assert.ok(nameInput);
    await act(async () => {
      setInputValue(nameInput, "Claude 团队号");
    });
    const saveBtn = dom.document.querySelector("[data-instance-save]") as unknown as HTMLButtonElement;
    await act(async () => {
      saveBtn.click();
    });
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0]?.displayName, "Claude 团队号");
    assert.deepEqual(submitted[0]?.environment, [
      {
        name: "ANTHROPIC_API_KEY",
        value: "",
        sensitive: true,
        valueRedacted: true,
      },
    ]);

    // 2) supports_shadow_home = true -> shadowHome option appears purely from capabilities
    // Also verify revealedRows is keyed by stable row.id rather than numeric index when removing a row
    await act(async () => {
      root.render(
        createElement(InstanceFormDialog, {
          open: true,
          kind: "claude-code",
          agentLabel: "Claude Code",
          instance: {
            ...existing,
            environment: [
              { name: "FIRST_SECRET", value: "plain-1", sensitive: true },
              { name: "SECOND_SECRET", value: "plain-2", sensitive: true },
            ],
          },
          capabilities: fullCaps({ supports_shadow_home: true }),
          onClose: () => undefined,
          onSubmit: async () => undefined,
        }),
      );
    });
    assert.ok(dom.document.querySelector('[data-instance-isolation="shadowHome"]'));

    // Reveal row 0, then delete row 0 -> remaining row (SECOND_SECRET) must stay password-masked!
    const revealFirstBtn = dom.document.querySelector(
      '[data-instance-env-row="0"] button[aria-label="显示变量值"]',
    ) as unknown as HTMLButtonElement;
    assert.ok(revealFirstBtn);
    await act(async () => {
      revealFirstBtn.click();
    });
    assert.equal(
      (dom.document.querySelector('[data-instance-env-value="0"]') as unknown as HTMLInputElement).type,
      "text",
    );
    const removeFirstBtn = dom.document.querySelector(
      '[data-instance-env-remove="0"]',
    ) as unknown as HTMLButtonElement;
    await act(async () => {
      removeFirstBtn.click();
    });
    const remainingValueInput = dom.document.querySelector(
      '[data-instance-env-value="0"]',
    ) as unknown as HTMLInputElement;
    assert.equal(remainingValueInput.value, "plain-2");
    assert.equal(remainingValueInput.type, "password");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("SettingsView mounts Agents multi-instance cards, Keybindings tab, TextGen section, and CLI command section", async () => {
  const profiles: Partial<Record<string, AgentProfile>> = {
    "codex-cli": {
      kind: "codex-cli",
      instance_id: "codex-cli",
      display_name: "Codex CLI",
      capabilities: fullCaps({ supports_multi_instance: true, supports_shadow_home: true }),
      commands: [],
    },
    "claude-code": {
      kind: "claude-code",
      instance_id: "claude-code",
      display_name: "Claude Code",
      capabilities: fullCaps({ supports_multi_instance: true, supports_shadow_home: false }),
      commands: [],
    },
    "opencode": {
      kind: "opencode",
      instance_id: "opencode",
      display_name: "OpenCode",
      capabilities: fullCaps({ supports_multi_instance: false, supports_text_generation: false }),
      commands: [],
    },
  };
  const installations: AgentInstallation[] = [
    {
      kind: "codex-cli",
      instance_id: "codex-cli",
      display_name: "Codex CLI",
      installed: true,
      version: "0.162.0",
      latest_version: null,
      update_available: false,
      update_via: null,
      detail: null,
      session_linked: true,
    },
    {
      kind: "claude-code",
      instance_id: "claude-code",
      display_name: "Claude Code",
      installed: false,
      version: null,
      latest_version: null,
      update_available: false,
      update_via: null,
      detail: null,
      session_linked: true,
    },
    {
      kind: "opencode",
      instance_id: "opencode",
      display_name: "OpenCode",
      installed: true,
      version: "1.0.0",
      latest_version: null,
      update_available: false,
      update_via: null,
      detail: null,
      session_linked: true,
    },
  ];
  const instances: AgentInstance[] = [
    {
      id: "codex-cli",
      kind: "codex-cli",
      displayName: "Codex 默认（已定制）",
      isolationMode: "hostDefault",
      enabled: true,
      isDefault: true,
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 50,
    },
    {
      id: "codex-shadow",
      kind: "codex-cli",
      displayName: "Codex 影子号",
      accentColor: "#3b82f6",
      isolationMode: "shadowHome",
      enabled: true,
      isDefault: false,
      sortOrder: 100,
      createdAt: 10,
      updatedAt: 10,
    },
  ];

  agentsMod.seedAgents(profiles, installations, instances);

  const savedTextGen: TextGenSettings[] = [];
  const origCall = daemonMod.daemon.call.bind(daemonMod.daemon);
  daemonMod.daemon.call = (async (method: string, params?: unknown) => {
    if (method === "settings.taskFolder") {
      return { path: "C:\\Users\\admn\\Chats", label: "C:\\Users\\admn\\Chats" };
    }
    if (method === "settings.worktrees") {
      return {
        root: "C:\\Users\\admn\\Worktrees",
        defaultRoot: "C:\\Users\\admn\\Worktrees",
        autoCleanup: true,
        keepCount: 10,
      };
    }
    if (method === "settings.textGen") {
      return {
        mode: "http",
        instanceId: "deleted-instance",
        model: null,
        autoTitle: true,
        http: {
          protocol: "openAi",
          baseUrl: "https://api.openai.com/v1",
          apiKey: "",
          apiKeyRedacted: true,
          model: "gpt-4o-mini",
        },
      } satisfies TextGenSettings;
    }
    if (method === "settings.setTextGen") {
      const next = params as TextGenSettings;
      savedTextGen.push(next);
      return {
        ...next,
        http: next.http ? { ...next.http, apiKey: "", apiKeyRedacted: true } : null,
      };
    }
    if (method === "settings.keybindings") {
      return { path: "C:\\Users\\admn\\.ai-workbench\\keybindings.json", rules: [], error: null };
    }
    return null;
  }) as typeof daemonMod.daemon.call;

  const host = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.appendChild(host as unknown as Parameters<typeof dom.document.body.appendChild>[0]);
  const root: Root = createRoot(host);

  try {
    await act(async () => {
      root.render(createElement(SettingsView));
    });

    // All 4 unified nav entries exist
    const navIds = [...host.querySelectorAll("[data-settings-nav]")].map((el) =>
      el.getAttribute("data-settings-nav"),
    );
    assert.deepEqual(navIds, ["agents", "mcp", "keybindings", "general"]);

    // Multi-instance section appears under Codex (installed) AND Claude (not on host PATH, so custom binaryPath can be configured), and NOT under OpenCode (supports_multi_instance: false)
    assert.ok(host.querySelector('[data-agent-instances="codex-cli"]'));
    assert.ok(host.querySelector('[data-agent-instances="claude-code"]'));
    assert.equal(host.querySelector('[data-agent-instances="opencode"]'), null);
    assert.ok(host.querySelector('[data-instance-color-dot="codex-shadow"]'));
    assert.equal(
      host.querySelector('[data-instance-isolation-badge="shadowHome"]')?.textContent,
      "影子目录（共享技能与历史）",
    );
    // Modified default has 恢复默认, non-default has 删除
    assert.ok(host.querySelector('[data-instance-reset="codex-cli"]'));
    assert.ok(host.querySelector('[data-instance-delete="codex-shadow"]'));

    // Switch to Keybindings tab
    const kbNav = host.querySelector('[data-settings-nav="keybindings"]') as HTMLButtonElement;
    await act(async () => kbNav.click());
    assert.match(host.textContent ?? "", /键盘快捷键/);

    // Switch to General tab -> mounts TextGenSettingsSection and CliCommandSection
    const generalNav = host.querySelector('[data-settings-nav="general"]') as HTMLButtonElement;
    await act(async () => generalNav.click());
    assert.ok(host.querySelector('[data-settings-panel="text-gen"]'));
    assert.ok(host.querySelector('[data-settings-panel="cli-command"]'));
    assert.match(host.textContent ?? "", /首条消息后自动生成会话标题/);
    assert.match(host.textContent ?? "", /命令行工具/);

    // Toggling autoTitle while mode is edited unsaved only persists autoTitle on lastSavedSettings
    const cliModeBtn = host.querySelector('[data-textgen-mode="cli"]') as HTMLButtonElement;
    await act(async () => cliModeBtn.click());
    const instanceSelect = host.querySelector("[data-textgen-instance]") as HTMLSelectElement;
    assert.equal(instanceSelect.value, "deleted-instance");
    assert.match(instanceSelect.textContent ?? "", /deleted-instance（不可用或已停用）/);
    const autoTitleSwitch = host.querySelector("[data-textgen-auto-title]") as HTMLButtonElement;
    await act(async () => autoTitleSwitch.click());
    assert.equal(savedTextGen.length, 1);
    assert.equal(savedTextGen[0]?.mode, "http");
    assert.equal(savedTextGen[0]?.autoTitle, false);
    assert.equal(savedTextGen[0]?.http?.apiKey, "");
    assert.equal(savedTextGen[0]?.http?.apiKeyRedacted, true);

    // Saving TextGen explicitly commits the edited mode while preserving apiKeyRedacted
    const saveTextGenBtn = host.querySelector("[data-textgen-save]") as HTMLButtonElement;
    await act(async () => saveTextGenBtn.click());
    assert.equal(savedTextGen.length, 2);
    assert.equal(savedTextGen[1]?.mode, "cli");
    assert.equal(savedTextGen[1]?.http?.apiKey, "");
    assert.equal(savedTextGen[1]?.http?.apiKeyRedacted, true);
  } finally {
    daemonMod.daemon.call = origCall;
    await act(async () => root.unmount());
    host.remove();
  }
});
