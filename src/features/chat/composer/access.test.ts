import assert from "node:assert/strict";
import { test } from "node:test";

import { emptySandbox } from "../../../types/index.ts";
import {
  addWritableRoot,
  buttonLabel,
  extrasAllowed,
  initialSandbox,
  NETWORK_LABEL,
  WRITABLE_HEADING,
  PERMISSION_BUTTON,
  sandboxFromMenu,
  selectPreset,
  selectProfile,
} from "./access.ts";
import { permissionMenuTitle, permissionRowDetail } from "./permission-label.ts";

const menu = {
  network_access: true,
  writable_roots: true,
  permission_profiles: true,
  approve_for_me: true,
  title: "Update Model Permissions",
  notice: null,
  active: "ask",
  presets: [
    { id: "ask", label: "Ask for approval", description: "", allows_extras: true },
    { id: "approve-for-me", label: "Approve for me", description: "", allows_extras: true },
    { id: "full", label: "Full Access", description: "", caution: true },
    { id: "read-only", label: "Read Only", description: "", allows_extras: true },
  ],
  profiles: [{ id: "project-edit", label: "project-edit", description: "" }],
};

test("workbench extras keep their own labels", () => {
  assert.equal(NETWORK_LABEL, "允许网络访问");
  assert.equal(WRITABLE_HEADING, "其他可写目录");
});

test("button label comes from the menu, with English preset titles localized", () => {
  const sandbox = selectPreset(emptySandbox(), "approve-for-me");
  assert.equal(buttonLabel(sandbox, null), PERMISSION_BUTTON);
  assert.equal(buttonLabel(null, menu), PERMISSION_BUTTON);
  assert.equal(buttonLabel(sandbox, menu), "替我批准");
  assert.equal(buttonLabel(selectProfile(sandbox, "project-edit"), menu), "project-edit");
  assert.equal(buttonLabel(selectPreset(emptySandbox(), "full"), menu), "完全访问");
  assert.equal(buttonLabel(selectPreset(emptySandbox(), "ask"), menu), "询问批准");
  assert.equal(buttonLabel(selectPreset(emptySandbox(), "read-only"), menu), "只读");
  assert.equal(permissionMenuTitle(menu.title), "权限");
  assert.equal(permissionMenuTitle("权限"), "权限");
  assert.equal(permissionRowDetail({ ...menu.presets[0], description: "Read and edit workspace files" }), null);
  assert.equal(
    permissionRowDetail({
      ...menu.presets[2],
      description: "Use with caution: Codex can edit files outside this workspace",
      disabled_reason: "Disabled by requirements",
    }),
    "Disabled by requirements",
  );
  const claude = {
    ...menu,
    title: "权限",
    presets: [
      { id: "full", label: "跳过权限检查", description: "bypass", caution: true },
      { id: "ask", label: "询问批准", description: "ask each time" },
    ],
  };
  assert.equal(buttonLabel(selectPreset(emptySandbox(), "full"), claude), "跳过权限检查");
  assert.equal(buttonLabel(selectPreset(emptySandbox(), "ask"), claude), "询问批准");
});

test("extras follow the selected preset flag", () => {
  for (const mode of ["ask", "read-only", "approve-for-me"] as const) {
    assert.equal(extrasAllowed(menu, selectPreset(emptySandbox(), mode)), true);
  }
  assert.equal(extrasAllowed(menu, selectPreset(emptySandbox(), "full")), false);
  assert.equal(extrasAllowed(menu, selectProfile(emptySandbox("ask"), "project-edit")), false);
  assert.equal(extrasAllowed(null, selectPreset(emptySandbox(), "ask")), false);
});

test("switching back from full access keeps the network choice", () => {
  const asked = { ...selectPreset(emptySandbox(), "ask"), networkAccess: true };
  const full = selectPreset(asked, "full");
  assert.equal(full.networkAccess, true);
  assert.equal(extrasAllowed(menu, full), false);
  const back = selectPreset(full, "approve-for-me");
  assert.equal(back.networkAccess, true);
  assert.equal(buttonLabel(back, null), PERMISSION_BUTTON);
});

test("a new session does not inherit another agent's sandbox", () => {
  const codex = { ...selectPreset(emptySandbox(), "full"), networkAccess: true, profileId: "project-edit" };
  assert.equal(initialSandbox(codex, "ask"), codex);
  assert.equal(initialSandbox(undefined, "ask")?.mode, "ask");
  assert.equal(initialSandbox(undefined, "ask")?.networkAccess, false);
  assert.equal(initialSandbox(undefined, "nope"), null);
  assert.equal(initialSandbox(undefined, null), null);
});

test("the menu's active preset fills a session that has no stored sandbox", () => {
  assert.equal(sandboxFromMenu(menu)?.mode, "ask");
  assert.equal(sandboxFromMenu({ ...menu, active: "project-edit" })?.profileId, "project-edit");
  assert.equal(sandboxFromMenu({ ...menu, active: "gpt-5.4" }), null);
  assert.equal(sandboxFromMenu(null), null);
});

test("add-dir skips the workspace and duplicates", () => {
  const cwd = "C:\\work\\repo";
  let sandbox = emptySandbox("ask");
  sandbox = addWritableRoot(sandbox, "C:/work/extra", cwd);
  sandbox = addWritableRoot(sandbox, "C:\\work\\extra\\", cwd);
  sandbox = addWritableRoot(sandbox, cwd, cwd);
  assert.deepEqual(sandbox.writableRoots, ["C:/work/extra"]);
});
