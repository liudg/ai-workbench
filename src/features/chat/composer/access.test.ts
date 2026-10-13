import assert from "node:assert/strict";
import { test } from "node:test";

import { sandboxForAgent } from "../../../lib/agents.ts";
import { emptySandbox } from "../../../types/index.ts";
import {
  addWritableRoot,
  buttonLabel,
  NETWORK_LABEL,
  sandboxAllowsExtras,
  selectPreset,
  selectProfile,
  WRITABLE_DETAIL,
} from "./access.ts";

test("workbench extras keep their own labels", () => {
  assert.equal(NETWORK_LABEL, "允许网络访问");
  assert.match(WRITABLE_DETAIL, /主工作区/);
});

test("button label comes from the adapter menu once it is loaded", () => {
  const menu = {
    network_access: true,
    writable_roots: true,
    permission_profiles: true,
    approve_for_me: true,
    title: "Update Model Permissions",
    notice: null,
    presets: [{ id: "approve-for-me", label: "Approve for me", description: "" }],
    profiles: [{ id: "project-edit", label: "project-edit", description: "" }],
  };
  const sandbox = selectPreset(emptySandbox(), "approve-for-me");
  assert.equal(buttonLabel(sandbox, null), "替我批准");
  assert.equal(buttonLabel(sandbox, menu), "Approve for me");
  assert.equal(buttonLabel(selectProfile(sandbox, "project-edit"), menu), "project-edit");
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
  assert.equal(buttonLabel(back, null), "替我批准");
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
