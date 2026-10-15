import assert from "node:assert/strict";
import { test } from "node:test";

import {
  activityStepTitle,
  activitySummary,
  foldActivity,
  isLiveThinking,
  viewedImagesLabel,
} from "./activity-fold.ts";
import type { SessionEvent, SessionEventBody } from "../../../types/index.ts";

function event(id: string, body: SessionEventBody): SessionEvent {
  return { id, session_id: "s", seq: 1, ts: 1, ...body };
}

function tool(
  id: string,
  name: string,
  summary: string,
  images?: string[],
): Extract<SessionEvent, { kind: "tool-call" }> {
  return { id, session_id: "s", seq: 1, ts: 1, kind: "tool-call", name, summary, images };
}

const POWERSHELL =
  `"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command '$r = Invoke-WebRequest https://example.invalid/defects' → completed`;

test("adjacent commands collapse to one counted line and keep short step titles", () => {
  const pieces = foldActivity([
    tool("a", "command", "检查了表格选中"),
    tool("b", "command", "查看了表格复制操作"),
    tool("c", "command", "复制了缺陷记录选中（只读）"),
  ]);
  assert.equal(pieces.length, 1);
  assert.equal(pieces[0].type, "tools");
  if (pieces[0].type !== "tools") return;
  assert.equal(pieces[0].summary, "已运行 3 条命令");
  assert.deepEqual(
    pieces[0].steps.map((step) => step.title),
    ["检查了表格选中", "查看了表格复制操作", "复制了缺陷记录选中（只读）"],
  );
});

test("adjacent MCP calls name the servers from the event summary", () => {
  const summary = activitySummary([
    tool("a", "browser_snapshot", "MCP Chrome browser_snapshot"),
    tool("b", "execute_code", "MCP Unitymcp execute_code"),
  ]);
  assert.equal(summary.text, "已使用 Chrome 和 Unitymcp 集成运行了命令");
  assert.equal(summary.webSearch, false);
  assert.equal(activityStepTitle("execute_code", "MCP Unitymcp execute_code"), "execute_code");
});

test("three integration names join with enumeration comma and 和", () => {
  const summary = activitySummary([
    tool("a", "t", "MCP Chrome t"),
    tool("b", "t", "MCP Unitymcp t"),
    tool("c", "t", "MCP Figma t"),
  ]);
  assert.equal(summary.text, "已使用 Chrome、Unitymcp 和 Figma 集成运行了命令");
});

test("server spelling is kept once, case-insensitively", () => {
  const summary = activitySummary([
    tool("a", "t", "MCP Chrome t"),
    tool("b", "t", "MCP chrome t"),
  ]);
  assert.equal(summary.text, "已使用 Chrome 集成运行了命令");
});

test("web search stays on the same line as an adjacent integration", () => {
  const summary = activitySummary([
    tool("a", "execute_code", "MCP Unitymcp execute_code"),
    tool("b", "web_search", "装备缺陷 已修复"),
  ]);
  assert.equal(summary.text, "已使用 Unitymcp 集成运行了命令");
  assert.equal(summary.webSearch, true);
});

test("a web-only group is just the search phrase", () => {
  const summary = activitySummary([
    tool("a", "web_search", "缺陷表"),
  ]);
  assert.equal(summary.text, "已搜索网页");
  assert.equal(summary.webSearch, false);
});

test("thinking splits tool groups and leaves no thinking row", () => {
  const pieces = foldActivity([
    event("c1", { kind: "agent-message", text: "先看表格。", phase: "commentary" }),
    event("t1", { kind: "thinking", text: "先核对选区。" }),
    tool("m1", "browser_snapshot", "MCP Chrome browser_snapshot"),
    tool("m2", "execute_code", "MCP Unitymcp execute_code"),
    event("t2", { kind: "thinking", text: "再看复制。" }),
    tool("k1", "command", "检查了表格选中"),
    tool("k2", "command", "查看了表格复制操作"),
    tool("k3", "command", "复制了缺陷记录选中（只读）"),
    event("note", { kind: "agent-message", text: "表格已读完。", phase: "commentary" }),
    tool("k4", "command", "git status"),
  ]);
  assert.deepEqual(
    pieces.map((piece) => piece.type),
    ["event", "tools", "tools", "event", "tools"],
  );
  assert.equal(JSON.stringify(pieces).includes("先核对选区"), false);
  assert.equal(JSON.stringify(pieces).includes("再看复制"), false);
  const groups = pieces.filter((piece) => piece.type === "tools");
  assert.equal(groups.length, 3);
  const [integrations, commands, trailing] = groups;
  assert.ok(integrations && integrations.type === "tools");
  assert.equal(integrations.summary, "已使用 Chrome 和 Unitymcp 集成运行了命令");
  assert.ok(commands && commands.type === "tools");
  assert.equal(commands.summary, "已运行 3 条命令");
  assert.ok(trailing && trailing.type === "tools");
  assert.equal(trailing.summary, "已运行 1 条命令");
});

test("live thinking is only while the latest visible event is still thinking", () => {
  const thinking = event("t1", { kind: "thinking", text: "思考中…" });
  const done = event("a1", { kind: "agent-message", text: "找到了入口。", phase: "commentary" });
  assert.equal(isLiveThinking([done, thinking]), true);
  assert.equal(isLiveThinking([thinking, done]), false);
  assert.equal(
    isLiveThinking([thinking, event("s1", { kind: "status-changed", status: "running" })]),
    true,
  );
  assert.equal(isLiveThinking([done, event("s2", { kind: "status-changed", status: "completed" })]), false);
});

test("a prompt between tools starts a new group", () => {
  const pieces = foldActivity([
    tool("k1", "command", "rg --files"),
    event("p1", {
      kind: "prompt",
      prompt_id: "ask",
      prompt_kind: "approval",
      question: "允许？",
      options: [],
      questions: [],
    }),
    tool("k2", "command", "git status"),
  ]);
  assert.deepEqual(
    pieces.map((piece) => piece.type),
    ["tools", "event", "tools"],
  );
});

test("powershell paths are not the step title", () => {
  const title = activityStepTitle("command", POWERSHELL);
  assert.equal(title.startsWith("Invoke-WebRequest"), true);
  assert.equal(title.includes("powershell.exe"), false);
  assert.equal(title.includes("WindowsPowerShell"), false);
  const rg = activityStepTitle(
    "command",
    `"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "rg -n \\"BagMain\\"" → completed`,
  );
  assert.equal(rg.startsWith("rg -n "), true);
  assert.equal(rg.includes("powershell.exe"), false);
  const pieces = foldActivity([
    tool("k1", "command", POWERSHELL),
    tool("k2", "command", "Get-Content -LiteralPath 'a.json' → completed"),
  ]);
  assert.equal(pieces[0]?.type, "tools");
  if (pieces[0]?.type !== "tools") return;
  assert.equal(pieces[0].summary, "已运行 2 条命令");
  assert.equal(pieces[0].steps[1].title, "Get-Content -LiteralPath 'a.json'");
});

test("coded MCP names supply the server when the summary is a short title", () => {
  const call = tool("a", "mcp__Unitymcp__execute_code", "检查了表格选中");
  assert.equal(activityStepTitle(call.name, call.summary), "检查了表格选中");
  assert.equal(activitySummary([call]).text, "已使用 Unitymcp 集成运行了命令");
  assert.equal(activityStepTitle("mcp__Chrome__browser_snapshot", ""), "browser_snapshot");
});

test("viewed images are their own rows and stay out of command groups", () => {
  const pieces = foldActivity([
    tool("k1", "command", "git status"),
    tool("i1", "image", "a.png", ["a.png", "b.png", "a.png"]),
    tool("i2", "imageView", "c.png", ["c.png"]),
    tool("k2", "command", "git diff"),
    tool("m1", "execute_code", "MCP Unitymcp execute_code"),
  ]);
  assert.deepEqual(
    pieces.map((piece) => piece.type),
    ["tools", "images", "images", "tools"],
  );
  const [commands, first, second, integrations] = pieces;
  assert.ok(commands && commands.type === "tools");
  assert.equal(commands.summary, "已运行 1 条命令");
  assert.equal(commands.steps.length, 1);
  assert.ok(first && first.type === "images");
  assert.equal(first.count, 2);
  assert.deepEqual(first.paths, ["a.png", "b.png"]);
  assert.equal(viewedImagesLabel(first.count), "已查看 2 张图像");
  assert.ok(second && second.type === "images");
  assert.equal(second.count, 1);
  assert.deepEqual(second.paths, ["c.png"]);
  assert.equal(viewedImagesLabel(second.count), "已查看 1 张图像");
  assert.ok(integrations && integrations.type === "tools");
  assert.equal(integrations.summary, "已使用 Unitymcp 集成运行了命令");
});

test("an image summary path is the thumbnail when the images list is empty", () => {
  const pieces = foldActivity([tool("i1", "local_image", "shot.png")]);
  assert.equal(pieces[0]?.type, "images");
  if (pieces[0]?.type !== "images") return;
  assert.equal(pieces[0].count, 1);
  assert.deepEqual(pieces[0].paths, ["shot.png"]);
});

test("thinking between single calls leaves stacked summaries and no thinking text", () => {
  const pieces = foldActivity([
    event("t1", { kind: "thinking", text: "先看背包里的宝石。" }),
    tool("m1", "execute_code", "MCP unityMCP execute_code"),
    event("t2", { kind: "thinking", text: "再开详情。" }),
    tool("m2", "execute_code", "MCP unityMCP execute_code"),
    event("t3", { kind: "thinking", text: "查一条命令。" }),
    tool("k1", "command", "检查了表格选中"),
    event("t4", { kind: "thinking", text: "再调一次集成。" }),
    tool("m3", "execute_code", "MCP unityMCP execute_code"),
    event("t5", { kind: "thinking", text: "最后一条命令。" }),
    tool("k2", "command", "git status"),
  ]);
  assert.deepEqual(
    pieces.map((piece) => (piece.type === "tools" ? piece.summary : piece.type)),
    [
      "已使用 unityMCP 集成运行了命令",
      "已使用 unityMCP 集成运行了命令",
      "已运行 1 条命令",
      "已使用 unityMCP 集成运行了命令",
      "已运行 1 条命令",
    ],
  );
  const text = JSON.stringify(pieces);
  assert.equal(text.includes("先看背包里的宝石"), false);
  assert.equal(text.includes("最后一条命令"), false);
  const groups = pieces.filter((piece) => piece.type === "tools");
  assert.deepEqual(
    groups.map((piece) => (piece.type === "tools" ? piece.steps.map((step) => step.title) : [])),
    [["execute_code"], ["execute_code"], ["检查了表格选中"], ["execute_code"], ["git status"]],
  );
});

test("empty thinking does not add a row", () => {
  const pieces = foldActivity([
    event("t1", { kind: "thinking", text: "   " }),
    tool("k1", "command", "git status"),
  ]);
  assert.deepEqual(
    pieces.map((piece) => piece.type),
    ["tools"],
  );
});
