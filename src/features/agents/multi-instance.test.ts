import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer, type ViteDevServer } from "vite";
import { fileURLToPath } from "node:url";

import type {
  AgentCapabilities,
  AgentCatalog,
  AgentInstallation,
  AgentInstance,
  AgentKind,
  AgentProfile,
  SubscriptionUsage,
} from "../../types/index.ts";

const rootDir = fileURLToPath(new URL("../../../", import.meta.url));

let server: ViteDevServer;
let agentsMod: typeof import("./index.ts");
let daemonMod: typeof import("../../lib/daemon/index.ts");
let subCacheMod: typeof import("../panel/core/subscription-cache.ts");
let stickyMod: typeof import("../workspace/new/sticky.ts");
let newComposerMod: typeof import("../workspace/new/use-new-composer.ts");

const memStorage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  writable: true,
  value: {
    getItem: (k: string) => memStorage.get(k) ?? null,
    setItem: (k: string, v: string) => memStorage.set(k, v),
    removeItem: (k: string) => memStorage.delete(k),
    clear: () => memStorage.clear(),
  },
});

before(async () => {
  server = await createServer({
    root: rootDir,
    configFile: `${rootDir}/vite.config.ts`,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    logLevel: "error",
  });
  daemonMod = (await server.ssrLoadModule("/src/lib/daemon/index.ts")) as typeof daemonMod;
  daemonMod.daemon.disable("unit-test");
  agentsMod = (await server.ssrLoadModule("/src/features/agents/index.ts")) as typeof agentsMod;
  subCacheMod = (await server.ssrLoadModule(
    "/src/features/panel/core/subscription-cache.ts",
  )) as typeof subCacheMod;
  stickyMod = (await server.ssrLoadModule(
    "/src/features/workspace/new/sticky.ts",
  )) as typeof stickyMod;
  newComposerMod = (await server.ssrLoadModule(
    "/src/features/workspace/new/use-new-composer.ts",
  )) as typeof newComposerMod;
});

after(async () => {
  await server?.close();
});

function baseCaps(overrides: Partial<AgentCapabilities> = {}): AgentCapabilities {
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

function makeCatalog(
  modelId: string,
  agent: AgentKind = "codex-cli",
  instanceId?: string | null,
): AgentCatalog {
  return {
    models: [
      {
        id: modelId,
        label: modelId.toUpperCase(),
        description: "",
        is_default: true,
        default_effort: "medium",
        efforts: [],
      },
    ],
    skills: [],
    commands: [],
    capabilities: baseCaps(),
    thread_model: "thread-override",
    thread_effort: "high",
    agent,
    instance_id: instanceId ?? null,
  };
}

test("multi-instance catalog cache isolates models per effectiveInstanceId and strips thread tuning", async () => {
  const { agentsApi } = agentsMod;
  agentsApi.clearCatalogCache();

  const personalCat = makeCatalog("gpt-personal", "codex-cli", "codex-cli");
  const workCat = makeCatalog("gpt-work-gateway", "codex-cli", "codex-work");

  agentsApi.rememberCatalog("codex-cli", personalCat, true);
  agentsApi.rememberCatalog("codex-cli", workCat, true, "codex-work");

  assert.equal(agentsApi.peekCatalog("codex-cli")?.models[0]?.id, "gpt-personal");
  assert.equal(agentsApi.peekCatalog("codex-cli", "codex-cli")?.models[0]?.id, "gpt-personal");
  assert.equal(agentsApi.peekCatalog("codex-cli", "codex-work")?.models[0]?.id, "gpt-work-gateway");
  assert.equal(agentsApi.peekCatalog("codex-cli", "codex-work")?.thread_model, null);
  assert.equal(agentsApi.peekCatalog("codex-cli", "codex-work")?.thread_effort, null);

  // Mismatched catalog.instance_id must never pollute another instance's cache
  const wrongInstanceCat = makeCatalog("wrong-model", "codex-cli", "codex-other");
  agentsApi.rememberCatalog("codex-cli", wrongInstanceCat, true, "codex-work");
  assert.equal(agentsApi.peekCatalog("codex-cli", "codex-work")?.models[0]?.id, "gpt-work-gateway");
});

test("cachedCatalog, loadCatalog, and draftPermissionMenu pass instanceId only when non-default", async () => {
  const { agentsApi } = agentsMod;
  agentsApi.clearCatalogCache();

  const calls: Array<{ method: string; params: unknown }> = [];
  const origCall = daemonMod.daemon.call.bind(daemonMod.daemon);
  daemonMod.daemon.call = (async (method: string, params?: unknown) => {
    calls.push({ method, params });
    if (method === "agents.catalog") {
      return makeCatalog("cached-work", "claude-code", "claude-work");
    }
    if (method === "agents.probeCatalog") {
      return makeCatalog("probed-work", "claude-code", "claude-work");
    }
    if (method === "agents.permissionMenu") {
      return {
        network_access: false,
        writable_roots: false,
        permission_profiles: false,
        approve_for_me: false,
        title: "权限",
        notice: null,
        presets: [],
        profiles: [],
      };
    }
    throw new Error(`unexpected rpc ${method}`);
  }) as typeof daemonMod.daemon.call;

  try {
    const seen: string[][] = [];
    await agentsApi.loadCatalog(
      "claude-code",
      "proj-1",
      (cat) => seen.push(cat.models.map((m) => m.id)),
      "claude-work",
    );
    await agentsApi.draftPermissionMenu("claude-code", "claude-work");
    await agentsApi.draftPermissionMenu("claude-code", "claude-code");

    assert.deepEqual(seen, [["cached-work"], ["probed-work"]]);
    assert.deepEqual(calls, [
      { method: "agents.catalog", params: { agent: "claude-code", instanceId: "claude-work" } },
      {
        method: "agents.probeCatalog",
        params: { agent: "claude-code", projectId: "proj-1", instanceId: "claude-work" },
      },
      {
        method: "agents.permissionMenu",
        params: { agent: "claude-code", instanceId: "claude-work" },
      },
      { method: "agents.permissionMenu", params: { agent: "claude-code" } },
    ]);
  } finally {
    daemonMod.daemon.call = origCall;
  }
});

test("indexProfiles and buildSelectableInstances support multiple instances and fallback when default is disabled", () => {
  const profilesList: AgentProfile[] = [
    {
      kind: "claude-code",
      instance_id: "claude-work",
      accent_color: "#10b981",
      display_name: "Claude 工作号",
      icon: "/claude.svg",
      capabilities: baseCaps({ supports_shadow_home: false }),
      commands: [],
    },
    {
      kind: "codex-cli",
      instance_id: "codex-cli",
      display_name: "Codex CLI",
      icon: "/codex.svg",
      capabilities: baseCaps({ supports_shadow_home: true }),
      commands: [],
    },
    {
      kind: "codex-cli",
      instance_id: "codex-shadow",
      accent_color: "#3b82f6",
      display_name: "Codex 副号",
      icon: "/codex.svg",
      capabilities: baseCaps({ supports_shadow_home: true }),
      commands: [],
    },
  ];

  const indexed = agentsMod.indexProfiles(profilesList);
  // Builtin claude-code is disabled, so claude-code falls back to claude-work capabilities while stripping custom instance identity
  assert.equal(indexed["claude-work"]?.display_name, "Claude 工作号");
  assert.equal(indexed["claude-work"]?.accent_color, "#10b981");
  assert.equal(indexed["claude-code"]?.display_name, "Claude Code");
  assert.equal(indexed["claude-code"]?.accent_color, null);
  assert.equal(indexed["claude-code"]?.instance_id, undefined);
  assert.equal(indexed["claude-code"]?.capabilities.supports_multi_instance, true);
  assert.equal(indexed["codex-cli"]?.display_name, "Codex CLI");
  assert.equal(indexed["codex-shadow"]?.display_name, "Codex 副号");

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
      installed: true,
      version: "2.1.0",
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
      displayName: "Codex CLI",
      isolationMode: "hostDefault",
      enabled: true,
      isDefault: true,
      sortOrder: 0,
      createdAt: 0,
      updatedAt: 0,
    },
    {
      id: "claude-code",
      kind: "claude-code",
      displayName: "Claude Code",
      isolationMode: "hostDefault",
      enabled: false,
      isDefault: true,
      sortOrder: 1,
      createdAt: 0,
      updatedAt: 1,
    },
    {
      id: "codex-shadow",
      kind: "codex-cli",
      displayName: "Codex 副号",
      accentColor: "#3b82f6",
      isolationMode: "shadowHome",
      enabled: true,
      isDefault: false,
      sortOrder: 100,
      createdAt: 10,
      updatedAt: 10,
    },
    {
      id: "claude-work",
      kind: "claude-code",
      displayName: "Claude 工作号",
      accentColor: "#10b981",
      isolationMode: "isolatedHome",
      enabled: true,
      isDefault: false,
      sortOrder: 101,
      createdAt: 20,
      updatedAt: 20,
    },
  ];

  const selectable = agentsMod.buildSelectableInstances(installations, instances, indexed);
  assert.ok(selectable);
  assert.deepEqual(
    selectable.map((item) => ({
      instanceId: item.instanceId,
      kind: item.kind,
      displayName: item.displayName,
      accentColor: item.accentColor,
      isDefault: item.isDefault,
    })),
    [
      {
        instanceId: "codex-cli",
        kind: "codex-cli",
        displayName: "Codex CLI",
        accentColor: null,
        isDefault: true,
      },
      {
        instanceId: "codex-shadow",
        kind: "codex-cli",
        displayName: "Codex 副号",
        accentColor: "#3b82f6",
        isDefault: false,
      },
      {
        instanceId: "claude-work",
        kind: "claude-code",
        displayName: "Claude 工作号",
        accentColor: "#10b981",
        isDefault: false,
      },
    ],
  );
});

test("subscription usage cache keys by effectiveInstanceId and passes non-default instanceId", async () => {
  subCacheMod.clearSubscriptionUsageCache();
  const fetched: Array<[AgentKind, string | undefined]> = [];

  const fetch = async (kind: AgentKind, instanceId?: string): Promise<SubscriptionUsage> => {
    fetched.push([kind, instanceId]);
    return {
      windows: [
        {
          id: "5h",
          label: "5 小时",
          remaining_percent: instanceId === "claude-work" ? 85 : 20,
        },
      ],
    };
  };

  await subCacheMod.refreshSubscriptionUsage("claude-code", fetch);
  await subCacheMod.refreshSubscriptionUsage("claude-code", fetch, "claude-work");

  assert.deepEqual(fetched, [
    ["claude-code", undefined],
    ["claude-code", "claude-work"],
  ]);
  assert.equal(
    subCacheMod.peekSubscriptionUsage("claude-code")?.windows[0]?.remaining_percent,
    20,
  );
  assert.equal(
    subCacheMod.peekSubscriptionUsage("claude-code", "claude-work")?.windows[0]?.remaining_percent,
    85,
  );
});

test("sticky selection & draftSelection isolate tuning per instanceId and recover when an instance is disabled", () => {
  memStorage.clear();
  stickyMod.rememberAgent("codex-cli", "codex-work");
  stickyMod.rememberTuning("codex-cli", { model: "gpt-personal", effort: "low" }, "codex-cli");
  stickyMod.rememberTuning("codex-cli", { model: "gpt-work", effort: "high" }, "codex-work");

  assert.deepEqual(stickyMod.stickySelection(), {
    agent: "codex-cli",
    instanceId: "codex-work",
  });
  assert.equal(stickyMod.stickyTuning("codex-cli", "codex-cli")?.model, "gpt-personal");
  assert.equal(stickyMod.stickyTuning("codex-cli", "codex-work")?.model, "gpt-work");

  const selectableBoth = [
    {
      instanceId: "codex-cli",
      kind: "codex-cli" as const,
      displayName: "Codex CLI",
      accentColor: null,
      isDefault: true,
      icon: null,
      monochromeIcon: false,
      capabilities: baseCaps(),
    },
    {
      instanceId: "codex-work",
      kind: "codex-cli" as const,
      displayName: "Codex Work",
      accentColor: "#10b981",
      isDefault: false,
      icon: null,
      monochromeIcon: false,
      capabilities: baseCaps(),
    },
  ];
  assert.deepEqual(
    newComposerMod.draftSelection("new:proj-1", { text: "", files: [], snippets: [] }, selectableBoth),
    { agent: "codex-cli", instanceId: "codex-work" },
  );

  // If "codex-work" is disabled/removed, draftSelection falls back to remaining enabled instance of same kind
  assert.deepEqual(
    newComposerMod.draftSelection(
      "new:proj-1",
      { text: "", files: [], snippets: [] },
      [selectableBoth[0]!],
    ),
    { agent: "codex-cli", instanceId: "codex-cli" },
  );
});

test("agent-store deduplicates TOPIC_AGENT_INSTANCES refreshes and ignores stale out-of-order responses", async () => {
  let profileCalls = 0;
  let installCalls = 0;
  const profileResolvers: Array<(list: AgentProfile[]) => void> = [];

  const origCall = daemonMod.daemon.call.bind(daemonMod.daemon);
  daemonMod.daemon.call = ((method: string) => {
    if (method === "agents.profiles") {
      profileCalls += 1;
      return new Promise<AgentProfile[]>((resolve) => {
        profileResolvers.push(resolve);
      });
    }
    if (method === "agents.installations") {
      installCalls += 1;
      return Promise.resolve<AgentInstallation[]>([
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
      ]);
    }
    return Promise.resolve(null);
  }) as typeof daemonMod.daemon.call;

  try {
    // 1) Duplicate concurrent refreshProfiles calls share a single RPC
    const p1 = agentsMod.refreshProfiles();
    const p2 = agentsMod.refreshProfiles();
    assert.equal(profileCalls, 1);

    await agentsMod.refreshInstallations();
    assert.equal(installCalls, 1);

    const baseSnapshot: AgentInstance[] = [
      {
        id: "codex-cli",
        kind: "codex-cli",
        displayName: "Codex v1",
        isolationMode: "hostDefault",
        enabled: true,
        isDefault: true,
        sortOrder: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    // Initial snapshot from N mounted components does not fire redundant refreshes
    agentsMod.syncAgentInstancesSnapshot(baseSnapshot);
    agentsMod.syncAgentInstancesSnapshot(baseSnapshot);
    assert.equal(profileCalls, 1);
    assert.equal(installCalls, 1);

    // 2) Updated snapshot reported by multiple mounted hooks triggers only ONE refresh
    const updatedSnapshot: AgentInstance[] = [{ ...baseSnapshot[0]!, displayName: "Codex v2", updatedAt: 2 }];
    agentsMod.syncAgentInstancesSnapshot(updatedSnapshot);
    agentsMod.syncAgentInstancesSnapshot(updatedSnapshot);
    agentsMod.syncAgentInstancesSnapshot(updatedSnapshot);
    const pAfterUpdate = agentsMod.refreshProfiles();
    assert.equal(profileCalls, 2);
    assert.equal(installCalls, 2);

    // 3) Resolve newer request #2 BEFORE stale request #1 -> stale #1 must NOT overwrite #2
    profileResolvers[1]!([
      {
        kind: "codex-cli",
        instance_id: "codex-cli",
        display_name: "Codex v2",
        capabilities: baseCaps(),
        commands: [],
      },
    ]);
    await pAfterUpdate;
    profileResolvers[0]!([
      {
        kind: "codex-cli",
        instance_id: "codex-cli",
        display_name: "Codex STALE v1",
        capabilities: baseCaps(),
        commands: [],
      },
    ]);
    await Promise.all([p1, p2]);

    const { act, createElement } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { Window } = await import("happy-dom");
    const dom = new Window({ url: "http://localhost/" });
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
      configurable: true,
      writable: true,
      value: true,
    });
    Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: dom });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      writable: true,
      value: dom.document,
    });
    const host = dom.document.createElement("div") as unknown as HTMLElement;
    dom.document.body.appendChild(
      host as unknown as Parameters<typeof dom.document.body.appendChild>[0],
    );
    const root = createRoot(host);
    try {
      const { useAgentState } = (await server.ssrLoadModule(
        "/src/features/agents/agent-store.ts",
      )) as typeof import("./agent-store.ts");
      let currentDisplay: string | null | undefined;
      await act(async () => {
        root.render(
          createElement(() => {
            currentDisplay = useAgentState((s) => s.profiles["codex-cli"]?.display_name);
            return null;
          }),
        );
      });
      assert.equal(currentDisplay, "Codex v2");
    } finally {
      await act(async () => root.unmount());
      await dom.close();
      Reflect.deleteProperty(globalThis, "window");
      Reflect.deleteProperty(globalThis, "document");
      Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    }
  } finally {
    daemonMod.daemon.call = origCall;
  }
});

test("syncAgentInstancesSnapshot evicts catalog and subscription usage caches only for mutated or deleted instances", () => {
  const { agentsApi } = agentsMod;
  agentsApi.clearCatalogCache();
  subCacheMod.clearSubscriptionUsageCache();

  const origCall = daemonMod.daemon.call.bind(daemonMod.daemon);
  daemonMod.daemon.call = (() => Promise.resolve([])) as typeof daemonMod.daemon.call;

  try {
    const defaultInst: AgentInstance = {
      id: "codex-cli",
      kind: "codex-cli",
      displayName: "Codex CLI",
      isolationMode: "hostDefault",
      launchArgs: [],
      environment: undefined,
      enabled: true,
      isDefault: true,
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 10,
    };
    const workInst: AgentInstance = {
      id: "codex-work",
      kind: "codex-cli",
      displayName: "Codex Work",
      isolationMode: "isolatedHome",
      homePath: "C:\\aiwb\\work",
      binaryPath: "C:\\bin\\codex.exe",
      launchArgs: ["--profile", "work"],
      environment: undefined,
      enabled: true,
      isDefault: false,
      sortOrder: 1,
      createdAt: 2,
      updatedAt: 10,
    };

    // Establish baseline for both instances
    agentsMod.syncAgentInstancesSnapshot([defaultInst, workInst]);

    // Populate catalog & subscription caches for both instances
    agentsApi.rememberCatalog("codex-cli", makeCatalog("gpt-default", "codex-cli", "codex-cli"), true);
    agentsApi.rememberCatalog("codex-cli", makeCatalog("gpt-work", "codex-cli", "codex-work"), true, "codex-work");
    subCacheMod.seedSubscriptionUsage("codex-cli", {
      windows: [{ id: "5h", label: "5 小时", remaining_percent: 40 }],
    });
    subCacheMod.seedSubscriptionUsage(
      "codex-cli",
      { windows: [{ id: "5h", label: "5 小时", remaining_percent: 90 }] },
      "codex-work",
    );

    // Identical snapshot leaves both caches intact
    agentsMod.syncAgentInstancesSnapshot([defaultInst, workInst]);
    assert.equal(agentsApi.peekCatalog("codex-cli")?.models[0]?.id, "gpt-default");
    assert.equal(agentsApi.peekCatalog("codex-cli", "codex-work")?.models[0]?.id, "gpt-work");
    assert.equal(subCacheMod.peekSubscriptionUsage("codex-cli")?.windows[0]?.remaining_percent, 40);
    assert.equal(
      subCacheMod.peekSubscriptionUsage("codex-cli", "codex-work")?.windows[0]?.remaining_percent,
      90,
    );

    // Mutating environment from undefined/null to [] (even with same updatedAt!) evicts ONLY codex-work
    const workEnvArray: AgentInstance = {
      ...workInst,
      environment: [],
    };
    agentsMod.syncAgentInstancesSnapshot([defaultInst, workEnvArray]);
    assert.equal(agentsApi.peekCatalog("codex-cli", "codex-work"), undefined);
    assert.equal(subCacheMod.peekSubscriptionUsage("codex-cli", "codex-work"), undefined);
    // Sibling default instance stays cached!
    assert.equal(agentsApi.peekCatalog("codex-cli")?.models[0]?.id, "gpt-default");
    assert.equal(subCacheMod.peekSubscriptionUsage("codex-cli")?.windows[0]?.remaining_percent, 40);

    // Re-populate codex-work and mutate launchArgs, then delete codex-work
    agentsApi.rememberCatalog("codex-cli", makeCatalog("gpt-work-v2", "codex-cli", "codex-work"), true, "codex-work");
    subCacheMod.seedSubscriptionUsage(
      "codex-cli",
      { windows: [{ id: "5h", label: "5 小时", remaining_percent: 75 }] },
      "codex-work",
    );
    const workArgsMutated: AgentInstance = {
      ...workEnvArray,
      launchArgs: ["--profile", "corp"],
    };
    agentsMod.syncAgentInstancesSnapshot([defaultInst, workArgsMutated]);
    assert.equal(agentsApi.peekCatalog("codex-cli", "codex-work"), undefined);
    assert.equal(subCacheMod.peekSubscriptionUsage("codex-cli", "codex-work"), undefined);

    // Re-populate codex-work and remove it from snapshot -> evicted cleanly
    agentsApi.rememberCatalog("codex-cli", makeCatalog("gpt-work-v3", "codex-cli", "codex-work"), true, "codex-work");
    subCacheMod.seedSubscriptionUsage(
      "codex-cli",
      { windows: [{ id: "5h", label: "5 小时", remaining_percent: 60 }] },
      "codex-work",
    );
    agentsMod.syncAgentInstancesSnapshot([defaultInst]);
    assert.equal(agentsApi.peekCatalog("codex-cli", "codex-work"), undefined);
    assert.equal(subCacheMod.peekSubscriptionUsage("codex-cli", "codex-work"), undefined);
    assert.equal(agentsApi.peekCatalog("codex-cli")?.models[0]?.id, "gpt-default");
    assert.equal(subCacheMod.peekSubscriptionUsage("codex-cli")?.windows[0]?.remaining_percent, 40);
  } finally {
    daemonMod.daemon.call = origCall;
  }
});
