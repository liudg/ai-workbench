import assert from "node:assert/strict";
import { test } from "node:test";

import { claudeSurface, codexSurface } from "./fixtures.ts";
import {
  FORM_TEXT,
  applyServerPaste,
  createDraft,
  draftToSpec,
  knownSpecId,
  parseListPaste,
  parsePairPaste,
  readServerPaste,
  validateDraft,
} from "./formDraft.ts";

test("form copy stays product Chinese", () => {
  for (const text of Object.values(FORM_TEXT)) {
    assert.equal(text.includes("未观察"), false, text);
    assert.equal(text.includes("未验证"), false, text);
    assert.equal(text.includes("动词"), false, text);
    assert.equal(text.includes("CLI"), false, text);
    assert.equal(/REA|debug/i.test(text), false, text);
  }
  assert.equal(FORM_TEXT.pasteConfig, "粘贴配置");
  assert.equal(FORM_TEXT.duplicateName, "已有同名服务器。");
});

test("surface fields map onto the add spec", () => {
  for (const surface of [codexSurface, claudeSurface]) {
    for (const field of surface.fields) {
      assert.equal(knownSpecId(field.id), true, field.id);
      assert.equal(field.control.length > 0, true, field.id);
    }
  }
});

test("stdio save requires a name and command, and reports the first field", () => {
  const draft = createDraft(codexSurface);
  draft.values.name = "has space";
  const checked = validateDraft(codexSurface, draft, []);
  assert.equal(checked.focusId, "name");
  assert.equal(checked.errors.name, "名称不能为空，也不能含空白。");
  draft.values.name = "bad\u009fname";
  assert.equal(validateDraft(codexSurface, draft, []).errors.name, "名称不能为空，也不能含空白。");

  draft.values.name = "demo";
  const missing = validateDraft(codexSurface, draft, ["demo"]);
  assert.equal(missing.errors.name, "已有同名服务器。");
  assert.equal(missing.errors.command, "请填写启动命令。");
  assert.equal(missing.focusId, "name");

  draft.values.name = "fresh";
  draft.values.command = "npx";
  draft.lists.args = ["-y", "  pkg  ", " "];
  draft.pairs.env = [
    { key: "API_KEY", value: "x" },
    { key: "", value: "" },
  ];
  assert.equal(validateDraft(codexSurface, draft, ["other"]).focusId, null);
  assert.deepEqual(draftToSpec(codexSurface, draft), {
    name: "fresh",
    transport: "stdio",
    command: "npx",
    args: ["-y", "  pkg  "],
    env: [{ key: "API_KEY", value: "x" }],
    url: "",
    bearer_token_env_var: "",
    headers: [],
    scope: "",
    client_id: "",
    client_secret: "",
    oauth_resource: "",
    callback_port: "",
    oauth_registration: "",
  });
});

test("remote fields are checked only when that transport is selected", () => {
  const draft = createDraft(codexSurface);
  draft.transport = "streamable_http";
  draft.values.name = "remote";
  draft.values.url = "HTTP://example.invalid/mcp";
  assert.equal(validateDraft(codexSurface, draft, []).errors.url, undefined);
  draft.values.url = "mcp.example.com";
  draft.values.bearer_token_env_var = "NOT A NAME";
  const checked = validateDraft(codexSurface, draft, []);
  assert.equal(checked.errors.command, undefined);
  assert.equal(checked.errors.url, "URL 需要以 http:// 或 https:// 开头。");
  assert.equal(checked.errors.bearer_token_env_var, "环境变量名无效：NOT A NAME");
  assert.equal(checked.focusId, "url");

  draft.values.url = "https://example.invalid/mcp";
  draft.values.bearer_token_env_var = "MCP_BEARER_TOKEN";
  draft.values.client_secret = " secret ";
  assert.equal(validateDraft(codexSurface, draft, []).focusId, null);
  const spec = draftToSpec(codexSurface, draft);
  assert.equal(spec.url, "https://example.invalid/mcp");
  assert.equal(spec.command, "");
  assert.equal(spec.client_secret, "secret");
  assert.equal(spec.oauth_registration, "auto");
});

test("claude checks headers, scope, and callback port", () => {
  const draft = createDraft(claudeSurface);
  draft.transport = "http";
  draft.scope = "project";
  draft.values.name = "remote";
  draft.values.url = "https://example.invalid/mcp";
  draft.values.callback_port = "0";
  draft.pairs.headers = [
    { key: "Authorization", value: "Bearer x" },
    { key: "Authorization", value: "again" },
  ];
  const checked = validateDraft(claudeSurface, draft, []);
  assert.equal(checked.errors.callback_port, "回调端口必须是正整数。");
  assert.equal(checked.errors.headers, "请求头名重复：Authorization");

  draft.values.callback_port = "8080";
  draft.pairs.headers = [{ key: "", value: "x" }];
  assert.equal(validateDraft(claudeSurface, draft, []).errors.headers, "请填写键。");

  draft.pairs.headers = [{ key: "Authorization", value: "Bearer x" }];
  assert.equal(validateDraft(claudeSurface, draft, []).focusId, null);
  const spec = draftToSpec(claudeSurface, draft);
  assert.equal(spec.transport, "http");
  assert.equal(spec.scope, "project");
  assert.equal(spec.callback_port, "8080");
  assert.deepEqual(spec.headers, [{ key: "Authorization", value: "Bearer x" }]);
  assert.equal(spec.oauth_registration, "");
});

test("pair and argument paste accept lines and JSON", () => {
  assert.deepEqual(parsePairPaste("API_KEY=x\nREGION=cn"), [
    { key: "API_KEY", value: "x" },
    { key: "REGION", value: "cn" },
  ]);
  assert.deepEqual(parsePairPaste('{"API_KEY":"x"}'), [{ key: "API_KEY", value: "x" }]);
  assert.deepEqual(parsePairPaste("Authorization: Bearer x"), [{ key: "Authorization", value: "Bearer x" }]);
  assert.equal(parsePairPaste("npx"), null);
  assert.equal(parsePairPaste('{"command":"npx","args":["-y"]}'), null);
  assert.deepEqual(parseListPaste("-y\npkg"), ["-y", "pkg"]);
  assert.deepEqual(parseListPaste('["-y","pkg"]'), ["-y", "pkg"]);
  assert.equal(parseListPaste("-y"), null);
});

test("pasted server JSON fills the fields this surface actually has", () => {
  const json = `
    \`\`\`json
    {
      "mcpServers": {
        "filesystem": {
          "command": "npx",
          "args": ["-y", "pkg"],
          "env": { "API_KEY": "x" }
        },
        "other": { "command": "cmd" }
      }
    }
    \`\`\`
  `;
  const many = readServerPaste(json);
  assert.equal(many.ok, false);
  if (!many.ok) assert.equal(many.error, "一次只能粘贴一个服务器。");

  const one = `{
    "mcpServers": {
      "filesystem": {
        "type": "http",
        "url": "https://example.invalid/mcp",
        "headers": { "Authorization": "Bearer x" }
      }
    }
  }`;
  const read = readServerPaste(one);
  assert.equal(read.ok, true);
  if (!read.ok) return;
  const codex = applyServerPaste(codexSurface, createDraft(codexSurface), read.server);
  assert.equal("error" in codex, false);
  if ("error" in codex) return;
  assert.equal(codex.draft.transport, "streamable_http");
  assert.equal(codex.draft.values.name, "filesystem");
  assert.equal(codex.draft.values.url, "https://example.invalid/mcp");
  assert.equal(codex.draft.pairs.headers, undefined);
  assert.equal(codex.notice, "已忽略 Headers，当前配置没有这一项。");

  const claude = applyServerPaste(claudeSurface, createDraft(claudeSurface), read.server);
  assert.equal("error" in claude, false);
  if ("error" in claude) return;
  assert.equal(claude.draft.transport, "http");
  assert.deepEqual(claude.draft.pairs.headers, [{ key: "Authorization", value: "Bearer x" }]);
  assert.equal(claude.notice, null);

  const commandArray = readServerPaste('{"command":["npx","-y","pkg"],"name":"files"}');
  assert.equal(commandArray.ok, true);
  if (!commandArray.ok) return;
  const applied = applyServerPaste(codexSurface, createDraft(codexSurface), commandArray.server);
  assert.equal("error" in applied, false);
  if ("error" in applied) return;
  assert.equal(applied.draft.values.command, "npx");
  assert.deepEqual(applied.draft.lists.args, ["-y", "pkg"]);
  assert.equal(applied.draft.transport, "stdio");

  const sse = readServerPaste('{"type":"sse","url":"https://example.invalid/sse","name":"live"}');
  assert.equal(sse.ok, true);
  if (!sse.ok) return;
  const codexSse = applyServerPaste(codexSurface, createDraft(codexSurface), sse.server);
  assert.equal("error" in codexSse, false);
  if ("error" in codexSse) return;
  assert.equal(codexSse.draft.transport, "streamable_http");
  assert.equal(codexSse.draft.values.url, "https://example.invalid/sse");
  const claudeSse = applyServerPaste(claudeSurface, createDraft(claudeSurface), sse.server);
  assert.equal("error" in claudeSse, false);
  if ("error" in claudeSse) return;
  assert.equal(claudeSse.draft.transport, "sse");
});
