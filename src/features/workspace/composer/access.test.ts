import assert from "node:assert/strict";
import { test } from "node:test";

import { emptySandbox } from "../../../types.ts";
import {
  addWritableRoot,
  buttonLabel,
  NETWORK_LABEL,
  PERMISSION_DETAILS,
  PERMISSION_HEADING,
  sandboxAllowsExtras,
  sandboxForAgent,
  selectPreset,
  selectProfile,
  WRITABLE_DETAIL,
} from "./access.ts";

test("desktop menu copy keeps the official order of ideas", () => {
  assert.equal(PERMISSION_HEADING, "操作应如何获得批准？");
  assert.match(PERMISSION_DETAILS.ask, /互联网/);
  assert.match(PERMISSION_DETAILS["approve-for-me"], /不安全/);
  assert.match(PERMISSION_DETAILS.full, /任何文件/);
  assert.equal(NETWORK_LABEL, "允许网络访问");
  assert.match(WRITABLE_DETAIL, /主工作区/);
});

test("network and extra dirs apply to ask, read-only, and approve-for-me", () => {
  for (const mode of ["ask", "read-only", "approve-for-me"] as const) {
    assert.equal(sandboxAllowsExtras(selectPreset(emptySandbox(), mode)), true);
  }
  assert.equal(sandboxAllowsExtras(selectPreset(emptySandbox(), "full")), false);
  assert.equal(
    sandboxAllowsExtras(selectProfile(emptySandbox("ask"), "project-edit")),
    false,
  );
});

test("switching back from full access keeps the network choice", () => {
  const asked = { ...selectPreset(emptySandbox(), "ask"), networkAccess: true };
  const full = selectPreset(asked, "full");
  assert.equal(full.networkAccess, true);
  assert.equal(sandboxAllowsExtras(full), false);
  const back = selectPreset(full, "approve-for-me");
  assert.equal(back.networkAccess, true);
  assert.equal(buttonLabel(back), "替我批准");
});

test("agents without sandbox extensions keep the three basic modes", () => {
  const picked = selectPreset(emptySandbox(), "approve-for-me");
  picked.networkAccess = true;
  picked.writableRoots = ["D:\\notes"];
  const basic = sandboxForAgent({ ...picked, profileId: "project-edit" });
  assert.equal(basic.mode, "ask");
  assert.equal(basic.profileId, "");
  assert.equal(basic.networkAccess, false);
  assert.deepEqual(basic.writableRoots, []);
  const kept = sandboxForAgent(picked, { supports_network_access: true });
  assert.equal(kept.mode, "approve-for-me");
  assert.equal(kept.networkAccess, true);
});

test("add-dir skips the workspace and duplicates", () => {
  const cwd = "C:\\work\\repo";
  let sandbox = emptySandbox("ask");
  sandbox = addWritableRoot(sandbox, "C:/work/extra", cwd);
  sandbox = addWritableRoot(sandbox, "C:\\work\\extra\\", cwd);
  sandbox = addWritableRoot(sandbox, cwd, cwd);
  assert.deepEqual(sandbox.writableRoots, ["C:/work/extra"]);
});
