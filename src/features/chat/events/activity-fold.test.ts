import assert from "node:assert/strict";
import { test } from "node:test";

import {
  activityStepTitle,
  activitySummary,
  foldActivity,
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

test("adjacent commands collapse to one counted line with a representative command and keep short step titles", () => {
  const pieces = foldActivity([
    tool("a", "command", "检查了表格选中"),
    tool("b", "command", "查看了表格复制操作"),
    tool("c", "command", "复制了缺陷记录选中（只读）"),
  ]);
  assert.equal(pieces.length, 1);
  assert.equal(pieces[0].type, "tools");
  if (pieces[0].type !== "tools") return;
  assert.equal(pieces[0].summary, "已运行 检查了表格选中 等 3 条命令");
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

test("reads, searches and edits expose representative basenames or commands and fall back when generic", () => {
  const mixed = activitySummary([
    tool("r1", "Read", "src/a.txt"),
    tool("c1", "command", "echo ok"),
    tool("r2", "Read", "src/b.txt"),
    tool("s1", "Search", "BagMain"),
    tool("e1", "Edit", "src/a.txt"),
  ]);
  assert.equal(mixed.text, "已读取 a.txt 等 2 个文件，运行 echo ok，搜索 BagMain，编辑 a.txt");
  assert.equal(activitySummary([tool("r", "Read", "src/components/TerminalPane.tsx")]).text, "已读取 TerminalPane.tsx");
  assert.equal(
    activitySummary([
      tool("r1", "Read", "src/components/TerminalPane.tsx"),
      tool("r2", "Read", "src/styles.css"),
      tool("r3", "Read", "src/App.tsx"),
      tool("r4", "Read", "src/shared/types.ts"),
    ]).text,
    "已读取 TerminalPane.tsx、styles.css 等 4 个文件",
  );
  // 同一文件分段读取两次只算 1 个文件；不同目录同名文件仍算 2 个文件。
  assert.equal(
    activitySummary([tool("r1", "Read", "src/styles.css"), tool("r2", "Read", "src/styles.css")]).text,
    "已读取 styles.css",
  );
  assert.equal(
    activitySummary([tool("r1", "Read", "src/a/index.ts"), tool("r2", "Read", "src/b/index.ts")]).text,
    "已读取 index.ts 等 2 个文件",
  );
  assert.equal(activitySummary([tool("g", "Grep", "x"), tool("l", "Glob", "*.ts")]).text, "已搜索 x 等 2 次");
  assert.equal(activitySummary([tool("w", "Write", "src/b.txt"), tool("m", "MultiEdit", "src/c.txt")]).text, "已编辑 b.txt、c.txt");
  assert.equal(activitySummary([tool("f", "WebFetch", "https://a")]).text, "已读取 https://a");
  assert.equal(activitySummary([tool("t", "TodoWrite", "plan"), tool("k", "manage_task", "kill")]).text, "已调用 TodoWrite 等 2 个工具");
  assert.equal(activitySummary([tool("c", "command", "ls"), tool("c2", "command", "pwd")]).text, "已运行 ls 等 2 条命令");

  // Cursor / Claude / Antigravity 泛指工具标题不当作具体对象名。
  assert.equal(activitySummary([tool("r", "Read", "Read")]).text, "已读取 1 个文件");
  assert.equal(activitySummary([tool("r", "Read", "Read File")]).text, "已读取 1 个文件");
  assert.equal(activitySummary([tool("e", "Edit", "Edit File")]).text, "已编辑 1 个文件");
  assert.equal(activitySummary([tool("r", "Read", "File a")]).text, "已读取 1 个文件");
  assert.equal(activitySummary([tool("r", "Read", "File /C:/ws/n.txt")]).text, "已读取 n.txt");
  assert.equal(activitySummary([tool("c", "command", "Terminal")]).text, "已运行 1 条命令");
  assert.equal(activitySummary([tool("c", "command", "Bash")]).text, "已运行 1 条命令");
  assert.equal(activitySummary([tool("c", "command", "PowerShell")]).text, "已运行 1 条命令");
  assert.equal(activitySummary([tool("c", "command", "")]).text, "已运行 1 条命令");
});

test("project paths relativize before target clipping and do not split surrogate pairs", () => {
  const project = "G:\\document\\ai-workbench";
  const pieces = foldActivity(
    [
      tool("c1", "command", "cat G:\\document\\ai-workbench\\src\\App.tsx"),
      tool("s1", "Grep", "G:\\document\\ai-workbench\\src\\features\\chat"),
    ],
    project,
  );
  assert.equal(pieces[0]?.type, "tools");
  if (pieces[0]?.type !== "tools") return;
  assert.equal(pieces[0].summary, "已运行 cat src/App.tsx，搜索 src/features/chat");
  assert.equal(pieces[0].steps[0].title, "cat src/App.tsx");

  const emojiSearch = activitySummary([tool("s", "Search", `${"a".repeat(26)}🔍bc`)]);
  assert.equal(emojiSearch.text, `已搜索 ${"a".repeat(26)}🔍…`);
  assert.equal(/[\uD800-\uDBFF]…$/.test(emojiSearch.text), false);
});

test("thinking splits tool groups and keeps its position", () => {
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
    ["event", "event", "tools", "event", "tools", "event", "tools"],
  );
  assert.equal(JSON.stringify(pieces).includes("先核对选区"), true);
  assert.equal(JSON.stringify(pieces).includes("再看复制"), true);
  const groups = pieces.filter((piece) => piece.type === "tools");
  assert.equal(groups.length, 3);
  const [integrations, commands, trailing] = groups;
  assert.ok(integrations && integrations.type === "tools");
  assert.equal(integrations.summary, "已使用 Chrome 和 Unitymcp 集成运行了命令");
  assert.ok(commands && commands.type === "tools");
  assert.equal(commands.summary, "已运行 检查了表格选中 等 3 条命令");
  assert.ok(trailing && trailing.type === "tools");
  assert.equal(trailing.summary, "已运行 git status");
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
  assert.equal(pieces[0].summary, "已运行 Invoke-WebRequest https://examp… 等 2 条命令");
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
  assert.equal(commands.summary, "已运行 git status");
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

test("thinking and single tool summaries retain their chronological order", () => {
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
      "event",
      "已使用 unityMCP 集成运行了命令",
      "event",
      "已使用 unityMCP 集成运行了命令",
      "event",
      "已运行 检查了表格选中",
      "event",
      "已使用 unityMCP 集成运行了命令",
      "event",
      "已运行 git status",
    ],
  );
  const text = JSON.stringify(pieces);
  assert.equal(text.includes("先看背包里的宝石"), true);
  assert.equal(text.includes("最后一条命令"), true);
  const groups = pieces.filter((piece) => piece.type === "tools");
  assert.deepEqual(
    groups.map((piece) => (piece.type === "tools" ? piece.steps.map((step) => step.title) : [])),
    [["execute_code"], ["execute_code"], ["检查了表格选中"], ["execute_code"], ["git status"]],
  );
});

test("thinking without a body neither adds a row nor splits the tools around it", () => {
  const pieces = foldActivity([
    event("t1", { kind: "thinking", text: "   " }),
    tool("k1", "command", "git status"),
    event("t2", { kind: "thinking", text: "思考中…" }),
    tool("k2", "command", "git diff"),
  ]);
  assert.deepEqual(
    pieces.map((piece) => piece.type),
    ["tools"],
  );
  assert.deepEqual(
    pieces.map((piece) => (piece.type === "tools" ? piece.steps.map((step) => step.id) : [])),
    [["k1", "k2"]],
  );
});
