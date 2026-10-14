import assert from "node:assert/strict";
import { test } from "node:test";

import { insertSkill, skillEmptyCopy } from "./skills.ts";

test("a failed skill list is not described as no match", () => {
  assert.equal(skillEmptyCopy({ hasCatalog: false, skillsError: null, listed: 0 }), "正在读取技能…");
  assert.equal(
    skillEmptyCopy({ hasCatalog: true, skillsError: "等待 Codex skills/list 超时", listed: 0 }),
    "等待 Codex skills/list 超时",
  );
  assert.equal(skillEmptyCopy({ hasCatalog: true, skillsError: null, listed: 0 }), "没有可用技能");
  assert.equal(skillEmptyCopy({ hasCatalog: true, skillsError: null, listed: 2 }), "没有匹配的技能");
});

test("slash mentions stay slash mentions and bare names keep the dollar prefix", () => {
  assert.equal(insertSkill("看 ", 2, "/review"), "看 /review ");
  assert.equal(insertSkill("$do", 3, "$docs"), "$docs ");
  assert.equal(insertSkill("$do", 3, "docs"), "$docs ");
});
