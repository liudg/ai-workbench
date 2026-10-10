import assert from "node:assert/strict";
import { test } from "node:test";

import { inlinePlain, parseAnswer, shortenLocalPath, type AnswerBlock, type Inline } from "./answer-markdown.ts";

const LONG = "F:/mercury_resource/client/mercury_ai/Assets/Scripts/CodeV_AI/Editor/AIEditorWindow.cs";

const SAMPLE = [
  "`mercury_ai` 是一个用 **Unity 2021.3.18f1c1、C#** 开发的战斗 AI 行为树编辑器。",
  "",
  "**功能**",
  "",
  "- **行为编排**：支持基础动作、执行子树。",
  "- **条件与目标处理**：支持条件检查、目标过滤。",
  "- **辅助计算**：支持变量设置。",
  "- **编辑操作**：提供配置列表。",
  "- **连接检查**：限制根节点数量。",
  "",
  "**目录与代码职责**",
  "",
  "| 路径 | 内容 |",
  "| --- | --- |",
  "| `Assets/Scripts/CodeV_AI/Editor` | AI 编辑器窗口 |",
  "| `Assets/Scripts/CodeV_AI/Runtime/NodeData` | 动作和条件的数据结构 |",
  "| `Assets/ThirdParty/AI/FNode` | 通用节点图框架 |",
  "| `Assets/ThirdParty/AI/VisualAssets` | UXML 布局 |",
  "| `Assets/ThirdParty/AI/Export/Graph_Unity` | 行为树 JSON |",
  "| `AIInput_Dev` | 配置表输入，当前有 428 个 `bytes` 文件 |",
  "| `AIOutput` | 导出的行为树 JSON |",
  "",
  "界面主要使用 **UI Toolkit**。",
  "",
  "阅读代码可以从这些文件开始：",
  "",
  `- [AIEditorWindow.cs](${LONG})：窗口创建、文件列表。`,
  "- [AIUtility.cs](F:/mercury_resource/client/mercury_ai/Assets/Scripts/CodeV_AI/Editor/Utility/AIUtility.cs)：文件路径和导出。",
  "- [ConfigUtility.cs](F:/mercury_resource/client/mercury_ai/Assets/Scripts/CodeV_AI/Editor/Utility/ConfigUtility.cs)：配置表查询。",
  "- [EditorGraphUtility.cs](F:/mercury_resource/client/mercury_ai/Assets/ThirdParty/AI/FNode/FNode.Editor/Utilities/EditorGraphUtility.cs)：转换为导出数据。",
  "",
  "编辑器预览：",
  "",
  "![编辑器](F:/mercury_resource/client/mercury_ai/Temp/editor-preview.png)",
  "",
  "见 (F:/mercury_resource/client/mercury_ai/Assets/Scripts/CodeV_AI/Editor/AIEditorWindow.cs)。",
].join("\n");

test("promotes a lone bold line to a heading and renders emphasis, lists, and code", () => {
  const blocks = parseAnswer(SAMPLE);
  const headings = blocks.filter((block) => block.type === "heading" || block.type === "section");
  assert.equal(inlinePlain(titleOf(headings[0])), "功能");
  const features = blocks.find((block) => block.type === "list");
  assert.ok(features && features.type === "list");
  assert.equal(features.meta, null);
  assert.equal(features.items.length, 5);
  assert.match(inlinePlain(features.items[0]), /行为编排/);

  const intro = blocks[0];
  assert.equal(intro.type, "paragraph");
  if (intro.type === "paragraph") {
    assert.ok(intro.inlines.some((node) => node.type === "code" && node.text === "mercury_ai"));
    assert.ok(intro.inlines.some((node) => node.type === "strong"));
  }
});

test("collapses a heading plus a large table, and keeps project-relative paths", () => {
  const blocks = parseAnswer(SAMPLE);
  const section = blocks.find((block) => block.type === "section" && block.meta.kind === "table");
  assert.ok(section && section.type === "section");
  assert.equal(inlinePlain(section.title), "目录与代码职责");
  assert.equal(section.meta.detail, "7 行");
  assert.equal(section.body.type, "table");
  if (section.body.type === "table") {
    assert.equal(section.body.meta, null);
    const path = section.body.rows[0][0].find((node) => node.type === "code");
    assert.ok(path && path.type === "code");
    assert.equal(path.display, undefined);
    assert.equal(path.text, "Assets/Scripts/CodeV_AI/Editor");
  }
});

test("collapses code-entry lists and shortens absolute paths on hover data", () => {
  const blocks = parseAnswer(SAMPLE);
  const files = blocks.find((block) => block.type === "list" && block.meta?.kind === "files");
  assert.ok(files && files.type === "list" && files.meta);
  assert.equal(files.meta.detail, "4 个文件");
  const link = files.items[0].find((node) => node.type === "link");
  assert.ok(link && link.type === "link");
  assert.equal(inlinePlain(link.inlines), "AIEditorWindow.cs");
  assert.equal(link.title, LONG);
  assert.equal(link.href, LONG);

  const prose = blocks.find(
    (block) => block.type === "paragraph" && inlinePlain(block.inlines).includes(LONG),
  );
  assert.ok(prose && prose.type === "paragraph");
  const path = prose.inlines.find((node) => node.type === "path");
  assert.ok(path && path.type === "path");
  assert.equal(path.display, "…/Editor/AIEditorWindow.cs");
  assert.equal(path.full, LONG);
  assert.ok(inlinePlain(prose.inlines).includes("。"));
});

test("keeps images, including local png paths, and leaves unsafe images as text", () => {
  const blocks = parseAnswer(SAMPLE);
  const image = blocks.find((block) => block.type === "image");
  assert.ok(image && image.type === "image");
  assert.equal(image.alt, "编辑器");
  assert.equal(image.source.type, "local");

  const unsafe = parseAnswer("看看 ![x](javascript:alert(1)) 结束");
  assert.equal(unsafe.length, 1);
  assert.equal(unsafe[0].type, "paragraph");
  if (unsafe[0].type === "paragraph") {
    assert.equal(inlinePlain(unsafe[0].inlines), "看看 ![x](javascript:alert(1)) 结束");
    assert.equal(unsafe[0].inlines.some((node) => node.type === "image"), false);
  }

  const remote = parseAnswer("预览\n\n![图](https://cdn.example.com/a.png)");
  assert.equal(remote[remote.length - 1]?.type, "image");
});

test("does not collapse a short table, a feature list, or a fenced snippet", () => {
  const blocks = parseAnswer(
    ["| A | B |", "| --- | --- |", "| 1 | 2 |", "| 3 | 4 |", "", "```ts", "export const n = 1;", "```"].join(
      "\n",
    ),
  );
  const table = blocks.find((block) => block.type === "table");
  assert.ok(table && table.type === "table");
  assert.equal(table.meta, null);
  assert.equal(table.rows.length, 2);
  const code = blocks.find((block) => block.type === "code");
  assert.ok(code && code.type === "code");
  assert.equal(code.meta, null);
  assert.equal(code.lang, "ts");
});

test("collapses a directory listing and a long file fence", () => {
  const tree = [
    "```",
    "Assets/",
    "├── Scripts",
    "│   ├── Editor",
    "│   └── Runtime",
    "├── ThirdParty",
    "│   └── AI",
    "└── AIOutput",
    "    └── tree.json",
    "```",
  ].join("\n");
  const blocks = parseAnswer(tree);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "code");
  if (blocks[0].type === "code") {
    assert.equal(blocks[0].meta?.kind, "directory");
  }

  const files = Array.from({ length: 8 }, (_, i) => `File${i}.cs`).join("\n");
  const fence = parseAnswer("```\n" + files + "\n```");
  assert.equal(fence[0].type, "code");
  if (fence[0].type === "code") assert.equal(fence[0].meta?.kind, "directory");
});

test("shortens long paths and keeps short ones", () => {
  assert.equal(shortenLocalPath(LONG), "…/Editor/AIEditorWindow.cs");
  assert.equal(shortenLocalPath("Assets/Scripts/CodeV_AI/Editor"), null);
  assert.equal(shortenLocalPath("https://cdn.example.com/a/b/c/d/e/f.png"), null);
  assert.equal(
    shortenLocalPath("C:\\Temp\\a\\b\\shot.png"),
    "…/b/shot.png",
  );
  const code = parseAnswer("`" + LONG + "`");
  assert.equal(code[0].type, "paragraph");
  if (code[0].type === "paragraph") {
    const node = code[0].inlines[0];
    assert.equal(node.type, "code");
    if (node.type === "code") {
      assert.equal(node.display, "…/Editor/AIEditorWindow.cs");
      assert.equal(node.title, LONG);
    }
  }
});

test("does not render images that sit inside code", () => {
  const blocks = parseAnswer("```\n![a](https://cdn.example.com/a.png)\n```\n\n之后");
  assert.equal(blocks[0].type, "code");
  if (blocks[0].type === "code") assert.match(blocks[0].text, /!\[a\]/);
  assert.equal(blocks.some((block) => block.type === "image"), false);
});

function titleOf(block: AnswerBlock | undefined): Inline[] {
  assert.ok(block);
  if (block.type === "heading" || block.type === "section") return block.type === "heading" ? block.inlines : block.title;
  assert.fail("expected a heading");
}
