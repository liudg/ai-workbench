import assert from "node:assert/strict";
import { test } from "node:test";

import {
  emptySandbox,
  type AgentCapabilities,
  type AgentCatalog,
  type SessionEvent,
} from "../../../types/index.ts";
import { composerCaps, composerCommands, deriveComposerView } from "./composer-view.ts";

const caps = {
  supports_slash: true,
  supports_resume: false,
  supports_questions: true,
  supports_tuning: true,
  supports_skills: true,
  supports_images: true,
  supports_queue: true,
  supports_plan: true,
  supports_review: true,
  changes: { turn_diff: false, per_file_patch: false, git_scopes: false },
} satisfies AgentCapabilities;

function view(patch: Partial<Parameters<typeof deriveComposerView>[0]> = {}) {
  return deriveComposerView({
    status: "completed",
    events: [],
    caps,
    permissionMenu: null,
    sandbox: emptySandbox(),
    commands: [{ name: "/review", hint: "审查" }],
    skills: [],
    catalog: undefined,
    tuning: undefined,
    catalogNotice: null,
    text: "",
    caret: 0,
    editingId: null,
    fileCount: 0,
    goalDraft: false,
    ...patch,
  });
}

test("queue keeps the composer open while a turn is running", () => {
  const running = view({ status: "running" });
  assert.equal(running.composerLocked, false);
  assert.equal(running.menusLocked, true);
  assert.equal(running.placeholder, "添加后续消息");
  assert.equal(running.stopMode, true);
  assert.equal(running.sendDisabled, false);
  const noQueue = view({
    status: "running",
    caps: { ...caps, supports_queue: false },
  });
  assert.equal(noQueue.composerLocked, true);
  assert.equal(noQueue.placeholder, "随心输入");
  assert.equal(view({ status: "stopped" }).placeholder, "会话已停止，请新建会话");
});

test("slash stays closed while a prompt is waiting or the turn is busy", () => {
  const prompt: SessionEvent = {
    id: "p",
    session_id: "s",
    seq: 1,
    ts: 1,
    kind: "prompt",
    prompt_id: "p1",
    prompt_kind: "approval",
    question: "允许？",
    options: [],
    questions: [],
  };
  assert.equal(view({ text: "/review", events: [prompt] }).slashOpen, false);
  assert.equal(view({ text: "/review", status: "running" }).slashOpen, false);
  assert.equal(view({ text: "/review" }).slashOpen, true);
  assert.equal(view({ text: "  ", fileCount: 0 }).sendDisabled, true);
  assert.equal(view({ text: "", fileCount: 1 }).sendDisabled, false);
});

test("an empty @ opens the add menu and a query stays a file search", () => {
  const empty = view({ text: "@", caret: 1 });
  assert.equal(empty.mentionOpen, true);
  assert.equal(empty.mentionAdd, true);
  assert.equal(empty.skillOpen, false);
  const files = view({ text: "@composer", caret: "@composer".length });
  assert.equal(files.mentionAdd, false);
  assert.equal(files.mentionQuery, "composer");
  assert.equal(view({ text: "$docs", caret: 5 }).skillOpen, true);
  assert.equal(view({ text: "$docs", caret: 5 }).mentionOpen, false);
});

test("goal draft and plan mode change the placeholder only when the composer is free", () => {
  assert.equal(view({ goalDraft: true }).placeholder, "描述你的目标，定义可衡量的成功标准");
  const plan: SessionEvent = {
    id: "plan",
    session_id: "s",
    seq: 1,
    ts: 1,
    kind: "collaboration-mode",
    mode: "plan",
  };
  assert.equal(view({ events: [plan] }).placeholder, "描述你的任务以生成计划");
  assert.equal(view({ events: [plan], goalDraft: true }).placeholder, "描述你的目标，定义可衡量的成功标准");
  assert.equal(view({ status: "running", goalDraft: true }).placeholder, "添加后续消息");
  assert.equal(view({ caps: undefined }).goalSupport, "loading");
  assert.equal(view({ caps: { ...caps, supports_goals: false } }).goalSupport, "unsupported");
});

const catalog: AgentCatalog = {
  models: [
    {
      id: "gpt-6.1-sol",
      label: "GPT-6.1-Sol",
      description: "",
      is_default: true,
      default_effort: "low",
      efforts: [
        { id: "low", description: "low-cli" },
        { id: "medium", description: "medium-cli" },
        { id: "high", description: "high-cli" },
      ],
    },
    {
      id: "gpt-5.4",
      label: "GPT-5.4",
      description: "",
      is_default: false,
      default_effort: "medium",
      efforts: [
        { id: "low", description: "low-cli" },
        { id: "medium", description: "medium-cli" },
        { id: "high", description: "high-cli" },
      ],
    },
  ],
  skills: [],
  commands: [],
  capabilities: caps,
  configured_model: "gpt-5.4",
  configured_effort: "high",
  cli_config_read: true,
};

test("the model button follows CLI config before the catalog default", () => {
  assert.equal(view({ catalog }).modelButton, "GPT-5.4 高");
  assert.equal(view({ catalog }).modelName, "GPT-5.4");
  assert.equal(view({ catalog }).effortLabel, "高");
  assert.equal(view({ catalog }).selectedEffort, "high");
  assert.equal(
    view({
      catalog: {
        ...catalog,
        thread_model: "gpt-6.1-sol",
        thread_effort: "medium",
      },
    }).modelButton,
    "GPT-6.1-Sol 中",
  );
  assert.equal(
    view({
      catalog: { ...catalog, configured_model: null, configured_effort: null },
    }).modelButton,
    "GPT-6.1-Sol 低",
  );
  assert.equal(
    view({
      catalog: {
        ...catalog,
        configured_model: null,
        configured_effort: null,
        cli_config_read: false,
      },
    }).modelButton,
    "未读到 CLI 默认模型",
  );
  assert.equal(
    view({ catalog, tuning: { model: "gpt-6.1-sol", effort: "high" } }).modelButton,
    "GPT-6.1-Sol 高",
  );
  const bare = {
    ...catalog,
    models: catalog.models.map((item) => ({ ...item, is_default: false })),
    configured_model: null,
    configured_effort: null,
  };
  assert.equal(view({ catalog: bare }).modelButton, "选择强度");
});

test("a known effort id uses the short Chinese label", () => {
  const bareEffort = {
    ...catalog,
    models: catalog.models.map((item) =>
      item.id === "gpt-5.4" ? { ...item, efforts: [{ id: "high", description: "" }] } : item,
    ),
  };
  assert.equal(view({ catalog: bareEffort }).modelButton, "GPT-5.4 高");
});

test("an unknown effort id is not translated from its description", () => {
  const bareEffort = {
    ...catalog,
    models: catalog.models.map((item) =>
      item.id === "gpt-5.4"
        ? { ...item, efforts: [{ id: "research", description: "Maximum reasoning effort" }] }
        : item,
    ),
    configured_effort: "research",
  };
  assert.equal(view({ catalog: bareEffort }).modelButton, "GPT-5.4 research");
  assert.equal(view({ catalog: bareEffort }).effortLabel, "research");
});

test("claude resolved model label keeps the effort slider model", () => {
  const claude: AgentCatalog = {
    agent: "claude-code",
    models: [
      {
        id: "opus",
        label: "gpt-6.1-sol",
        description: "Custom Opus model",
        is_default: true,
        default_effort: "high",
        efforts: [
          { id: "low", description: "" },
          { id: "medium", description: "" },
          { id: "high", description: "" },
          { id: "xhigh", description: "" },
          { id: "max", description: "" },
        ],
        resolved_model: "gpt-6.1-sol",
      },
    ],
    skills: [],
    commands: [],
    capabilities: caps,
    configured_model: null,
    configured_effort: null,
    thread_model: "gpt-6.1-sol",
    thread_effort: "high",
    cli_config_read: true,
  };
  const shown = view({ catalog: claude });
  assert.equal(shown.selectedModel?.id, "opus");
  assert.equal(shown.selectedEffort, "high");
  assert.equal(shown.effortLabel, "高");
  assert.equal(shown.modelButton, "gpt-6.1-sol 高");
});

test("a claude catalog ignores a gpt id that is not in its model list", () => {
  const claude: AgentCatalog = {
    agent: "claude-code",
    models: [
      {
        id: "claude-sonnet",
        label: "Sonnet",
        description: "",
        is_default: true,
        default_effort: "medium",
        efforts: [{ id: "medium", description: "", label: "平衡" }],
      },
    ],
    skills: [],
    commands: [],
    capabilities: caps,
    configured_model: "gpt-6.1-sol",
    configured_effort: "high",
    thread_model: "gpt-6.1-sol",
    thread_effort: "high",
    cli_config_read: true,
  };
  const shown = view({ catalog: claude, tuning: { model: "gpt-6.1-sol", effort: "high" } });
  assert.equal(shown.selectedModel?.id, "claude-sonnet");
  assert.equal(shown.modelButton, "Sonnet 中");
  assert.equal(shown.modelButton.includes("gpt"), false);
});

test("fast mode is on only when this model advertises the fast tier", () => {
  assert.equal(view({ catalog }).fastAvailable, false);
  assert.equal(view({ catalog }).fastOn, false);
  const unmarked = {
    ...catalog,
    configured_service_tier: "fast",
    models: catalog.models.map((item) =>
      item.id === "gpt-5.4"
        ? { ...item, service_tiers: [{ id: "fast", name: "Fast", description: "1.5x" }] }
        : item,
    ),
  };
  assert.equal(view({ catalog: unmarked }).fastAvailable, false);
  assert.equal(view({ catalog: unmarked }).fastOn, false);
  const withFast = {
    ...catalog,
    configured_service_tier: "fast",
    models: catalog.models.map((item) =>
      item.id === "gpt-5.4"
        ? { ...item, service_tiers: [{ id: "fast", name: "Fast", description: "1.5x", fast: true }] }
        : item,
    ),
  };
  assert.equal(view({ catalog: withFast }).fastOn, true);
  assert.equal(view({ catalog: withFast }).fastAvailable, true);
  assert.equal(
    view({ catalog: withFast, tuning: { model: "gpt-5.4", effort: "high", serviceTier: null } }).fastOn,
    false,
  );
  assert.equal(view({ catalog: withFast }).baselineModelId, "gpt-5.4");
  assert.equal(view({ catalog: withFast }).baselineEffort, "high");
  assert.equal(view({ catalog: withFast }).baselineServiceTier, "fast");
  assert.equal(view({ catalog: withFast }).fastTip, "1.5x");
});

test("network and commands come from this session payload", () => {
  const menu = {
    network_access: true,
    writable_roots: false,
    permission_profiles: false,
    approve_for_me: false,
    title: "权限",
    notice: null,
    presets: [{ id: "ask", label: "询问批准", description: "", allows_extras: true }],
    profiles: [],
  };
  const shown = view({
    caps: { ...caps, supports_network_access: true, supports_writable_roots: true },
    permissionMenu: menu,
    sandbox: emptySandbox("ask"),
  });
  assert.equal(shown.showNetwork, true);
  assert.equal(shown.showWritable, false);
  assert.equal(view({ permissionMenu: menu, sandbox: emptySandbox("full") }).showNetwork, false);
  assert.equal(view({ caps: { ...caps, supports_network_access: true } }).showNetwork, false);
  const profile = {
    kind: "codex-cli" as const,
    capabilities: { ...caps, supports_tuning: false },
    commands: [{ name: "/review", hint: "审查" }],
  };
  assert.equal(composerCaps(catalog, profile)?.supports_tuning, true);
  assert.deepEqual(composerCommands(catalog, profile), []);
  assert.equal(composerCommands(undefined, profile)[0]?.name, "/review");
});

test("plan and goal chips are exclusive and the goal bar follows the goal", () => {
  const plan: SessionEvent = {
    id: "plan",
    session_id: "s",
    seq: 1,
    ts: 1,
    kind: "collaboration-mode",
    mode: "plan",
  };
  const drafted = view({ events: [plan], goalDraft: true });
  assert.equal(drafted.planOn, false);
  assert.equal(drafted.goalOn, true);
  assert.equal(drafted.goalStatus, "设置要持续追求的目标");
  const planning = view({ events: [plan] });
  assert.equal(planning.planOn, true);
  assert.equal(planning.goalOn, false);
  assert.equal(planning.goalStatus, null);
  const live = view({
    goalLive: true,
    goal: {
      objective: "把测试补上",
      status: "active",
      tokenBudget: 50000,
      tokensUsed: 12500,
      timeUsedSeconds: 90,
    },
  });
  assert.equal(live.goalOn, true);
  assert.equal(live.goalStatus, "正在追求目标 (12.5K / 50K)");
});

test("context usage events do not become a composer strip", () => {
  const shown = view({
    events: [
      {
        id: "usage-window",
        session_id: "s",
        seq: 1,
        ts: 1,
        kind: "context-usage",
        source: "get_context_usage",
        percentage: 23,
        used_tokens: 45137,
        max_tokens: 200000,
        model: "grok-4.7",
      },
      {
        id: "usage-turn",
        session_id: "s",
        seq: 2,
        ts: 2,
        kind: "context-usage",
        source: "partial-usage",
        input_tokens: 12,
        output_tokens: 4,
      },
      {
        id: "session-usage",
        session_id: "s",
        seq: 3,
        ts: 3,
        kind: "session-usage",
        scope: "snapshot",
        input_tokens: 8000,
        output_tokens: 2300,
        cache_read_tokens: 1500,
        cache_write_tokens: 500,
      },
    ],
  });
  assert.equal("contextUsage" in shown, false);
  assert.equal("sessionUsage" in shown, false);
  const rendered = JSON.stringify(shown);
  assert.equal(rendered.includes("45137"), false);
  assert.equal(rendered.includes("8000"), false);
  assert.equal(rendered.includes("12.3K"), false);
  assert.equal(rendered.includes("本回合"), false);
  assert.equal(rendered.includes("grok-4.7"), false);
});
