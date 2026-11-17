import assert from "node:assert/strict";
import { test } from "node:test";

import { hasThinkingBody, thinkingSummary } from "./thinking-summary.ts";

test("thinkingSummary extracts the first meaningful line and strips markdown", () => {
  assert.equal(
    thinkingSummary("\n\n**Checking console contrast**\n\nInspecting `TerminalPane.tsx` next."),
    "Checking console contrast",
  );
  assert.equal(
    thinkingSummary("Examining `styles.css`, [App.tsx](file:///src/App.tsx), and `terminalManager.ts`.\n\nMore details."),
    "Examining styles.css, App.tsx, and terminalManager.ts.",
  );
  assert.equal(
    thinkingSummary("### 1. 排查浅色模式\n- 先看配色变量"),
    "排查浅色模式",
  );
  assert.equal(
    thinkingSummary("> ### 1. 引用里的标题\n正文"),
    "引用里的标题",
  );
  assert.equal(
    thinkingSummary("- [x] 读取 `configStore.ts` 核对默认主题"),
    "读取 configStore.ts 核对默认主题",
  );
  assert.equal(
    thinkingSummary("先看*浅色模式*，再核对 `2*x*3` 计算"),
    "先看浅色模式，再核对 2*x*3 计算",
  );
});

test("thinkingSummary protects inline code and snake_case identifiers from markdown stripping", () => {
  assert.equal(
    thinkingSummary("Check `__dirname` and `__filename` in `config.ts`"),
    "Check __dirname and __filename in config.ts",
  );
  assert.equal(
    thinkingSummary("查看 __init__.py 与 `[a](b)` 解析器"),
    "查看 __init__.py 与 [a](b) 解析器",
  );
  assert.equal(
    thinkingSummary("```foo``` 是围栏标记"),
    "foo 是围栏标记",
  );
});

test("thinkingSummary skips fenced code blocks, rules, and placeholder thinking text", () => {
  assert.equal(thinkingSummary("   \n  "), "");
  assert.equal(hasThinkingBody("思考中…"), false);
  assert.equal(hasThinkingBody(" 思考中... "), false);
  assert.equal(hasThinkingBody("   "), false);
  assert.equal(hasThinkingBody("先看目录"), true);
  assert.equal(thinkingSummary("思考中…"), "");
  assert.equal(thinkingSummary("思考中..."), "");
  assert.equal(
    thinkingSummary("---\n```ts\nconst a = 1;\n```\nFirst real thought line"),
    "First real thought line",
  );
  assert.equal(thinkingSummary("```ts\nconst unclosed = true;"), "");
});

test("thinkingSummary clips by Unicode code points without splitting surrogate pairs", () => {
  const emojiBoundary = `${"a".repeat(118)}🔍bc`;
  const clipped = thinkingSummary(emojiBoundary);
  assert.equal(Array.from(clipped).length, 120);
  assert.equal(clipped, `${"a".repeat(118)}🔍…`);
  assert.equal(/[\uD800-\uDBFF]$/.test(clipped.slice(0, -1)), false);
});
