import assert from "node:assert/strict";
import { test } from "node:test";

import { commandFilter } from "./fuzzy.ts";

const fixtures: { value: string; search: string; keywords: string[]; score: number }[] = [
  { value: "新聊天", search: "新", keywords: [], score: 110027 },
  { value: "新聊天", search: "聊天", keywords: [], score: 17 },
  { value: "新聊天", search: "zzz", keywords: [], score: 0 },
  { value: "新聊天", search: "", keywords: [], score: 1 },
  { value: "Settings", search: "set", keywords: [], score: 110002 },
  { value: "src/App.tsx", search: "app", keywords: [], score: 9969 },
  { value: "src/App.tsx", search: "src/app", keywords: [], score: 110009 },
  { value: "显示/隐藏侧边栏", search: "侧边", keywords: [], score: 1 },
  { value: "归档聊天", search: "归档", keywords: ["archive"], score: 110026 },
  { value: "设置…", search: "set", keywords: ["settings"], score: 110022 },
  { value: "打开命令菜单", search: "命令", keywords: [], score: 4 },
  { value: "搜索文件…", search: "文件", keywords: [], score: 5 },
  { value: "HelloWorld", search: "HW", keywords: [], score: 109890 },
  { value: "toggleSidebar", search: "side", keywords: ["显示/隐藏侧边栏"], score: 9987 },
];

test("command filter matches the Codex desktop scores", () => {
  for (const fixture of fixtures) {
    assert.equal(
      commandFilter(fixture.value, fixture.search, fixture.keywords),
      fixture.score,
      `${fixture.value} / ${fixture.search}`,
    );
  }
});

test("async result values stay at the smallest positive score", () => {
  assert.equal(
    commandFilter("command-menu-async-result:1", "a", []),
    Number.MIN_VALUE,
  );
});
