import assert from "node:assert/strict";
import { test } from "node:test";

import {
  UPDATE_ENDPOINT,
  configuredUpdateEndpoint,
  updateFailureIsMissingSource,
} from "./update-source.ts";

test("placeholder and empty update endpoints are not checked", () => {
  assert.equal(UPDATE_ENDPOINT, "");
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

test("owner placeholder and empty plugin endpoints read as no source", () => {
  assert.equal(updateFailureIsMissingSource("Could not fetch a valid release JSON from https://github.com/OWNER/REPO/releases/latest/download/latest.json"), true);
  assert.equal(updateFailureIsMissingSource("empty endpoints"), true);
  assert.equal(updateFailureIsMissingSource("Updater does not have any endpoints set."), true);
  assert.equal(updateFailureIsMissingSource("network down"), false);
});
