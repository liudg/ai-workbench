import assert from "node:assert/strict";
import { test } from "node:test";

import type { McpServerRow } from "@/types";
import { emptyBook, finishList, patchRows, startList, visibleList } from "./listState.ts";

function row(name: string): McpServerRow {
  return {
    name,
    transport: "",
    command: "",
    args: [],
    url: "",
    bearer_token_env_var: "",
    enabled: true,
    auth_status: "",
    status_text: "",
    scope: "",
    cwd: "",
    env: [],
    env_vars: [],
    headers: [],
    env_headers: [],
  };
}

test("a stale list response cannot paint another agent's rows", () => {
  let book = startList(emptyBook(), "codex-cli", 1, false);
  book = finishList(book, "codex-cli", 1, { rows: [row("codex-server")] });
  book = startList(book, "cursor-agent", 1, false);

  const cursor = visibleList(book, "cursor-agent");
  assert.equal(cursor.listing, true);
  assert.deepEqual(cursor.rows, []);

  book = finishList(book, "codex-cli", 1, { rows: [row("codex-late")] });
  assert.deepEqual(
    visibleList(book, "cursor-agent").rows.map((item) => item.name),
    [],
  );
  assert.equal(visibleList(book, "cursor-agent").listing, true);
  assert.deepEqual(
    visibleList(book, "codex-cli").rows.map((item) => item.name),
    ["codex-late"],
  );

  book = finishList(book, "cursor-agent", 1, { rows: [row("cursor-server")] });
  assert.deepEqual(
    visibleList(book, "cursor-agent").rows.map((item) => item.name),
    ["cursor-server"],
  );
  assert.equal(visibleList(book, "cursor-agent").listing, false);
});

test("an older response for the same agent is ignored", () => {
  let book = startList(emptyBook(), "cursor-agent", 1, false);
  book = startList(book, "cursor-agent", 2, false);
  book = finishList(book, "cursor-agent", 1, { rows: [row("stale")] });
  assert.equal(visibleList(book, "cursor-agent").listing, true);
  assert.deepEqual(visibleList(book, "cursor-agent").rows, []);
  book = finishList(book, "cursor-agent", 2, { error: "超时" });
  assert.equal(visibleList(book, "cursor-agent").error, "超时");
  assert.equal(visibleList(book, "cursor-agent").listing, false);
});

test("a local patch shows at once and a refresh started after it replaces it", () => {
  let book = finishList(startList(emptyBook(), "claude-code", 1, false), "claude-code", 1, {
    rows: [row("a"), row("b")],
  });
  book = startList(book, "claude-code", 2, true);
  book = patchRows(book, "claude-code", (rows) => rows.filter((item) => item.name !== "a"));
  book = startList(book, "claude-code", 3, true);
  assert.deepEqual(visibleList(book, "claude-code").rows.map((item) => item.name), ["b"]);
  book = finishList(book, "claude-code", 2, { rows: [row("a"), row("b")] });
  assert.deepEqual(visibleList(book, "claude-code").rows.map((item) => item.name), ["b"]);
  book = finishList(book, "claude-code", 3, { rows: [row("b"), row("c")] });
  assert.deepEqual(visibleList(book, "claude-code").rows.map((item) => item.name), ["b", "c"]);
  assert.equal(patchRows(emptyBook(), "codex-cli", () => []).agents["codex-cli"], undefined);
});
