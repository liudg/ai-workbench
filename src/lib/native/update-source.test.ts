import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  UPDATE_ENDPOINT,
  configuredUpdateEndpoint,
  formatUpdaterError,
  updateFailureIsMissingSource,
} from "./update-source.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

test("configured update endpoint matches tauri.conf.json", () => {
  const conf = JSON.parse(
    readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"),
  );
  assert.equal(
    UPDATE_ENDPOINT,
    "https://github.com/liudg/ai-workbench/releases/latest/download/latest.json",
  );
  assert.deepEqual(conf.plugins?.updater?.endpoints, [UPDATE_ENDPOINT]);
  assert.equal(configuredUpdateEndpoint(), UPDATE_ENDPOINT);
  assert.ok(conf.plugins?.updater?.pubkey?.trim());
});

test("placeholder and empty update endpoints are not checked", () => {
  assert.equal(configuredUpdateEndpoint(""), null);
  assert.equal(configuredUpdateEndpoint("   "), null);
  assert.equal(
    configuredUpdateEndpoint("https://github.com/OWNER/REPO/releases/latest/download/latest.json"),
    null,
  );
  assert.equal(configuredUpdateEndpoint("http://example.com/latest.json"), null);
  assert.equal(
    configuredUpdateEndpoint("https://downloads.example.com/latest.json"),
    "https://downloads.example.com/latest.json",
  );
});

test("owner placeholder and empty plugin endpoints read as no source, not real remote errors", () => {
  assert.equal(
    updateFailureIsMissingSource(
      "Could not fetch a valid release JSON from https://github.com/OWNER/REPO/releases/latest/download/latest.json",
    ),
    true,
  );
  assert.equal(
    updateFailureIsMissingSource("Could not fetch a valid release JSON from the remote"),
    false,
  );
  assert.equal(updateFailureIsMissingSource("empty endpoints"), true);
  assert.equal(updateFailureIsMissingSource("Updater does not have any endpoints set."), true);
  assert.equal(updateFailureIsMissingSource("network down"), false);
});

test("formatUpdaterError maps low-level English errors to concise Chinese messages", () => {
  assert.equal(
    formatUpdaterError("Could not fetch a valid release JSON from the remote", "check"),
    "暂时获取不到更新信息，请稍后再试。",
  );
  assert.equal(
    formatUpdaterError(
      "error sending request for url (https://github.com/liudg/ai-workbench/releases/latest/download/latest.json)",
      "check",
    ),
    "网络连接异常，无法检查更新。",
  );
  assert.equal(
    formatUpdaterError("`Download request failed with status: 404 Not Found`", "download"),
    "下载更新包失败，请检查网络后重试。",
  );
  assert.equal(
    formatUpdaterError("The signature verification failed", "download"),
    "更新包签名校验未通过，请稍后再试。",
  );
  assert.equal(
    formatUpdaterError("installer exited with non-zero code", "install"),
    "更新未能完成，请稍后再试。",
  );
});
