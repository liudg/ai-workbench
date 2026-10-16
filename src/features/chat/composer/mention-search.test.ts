import assert from "node:assert/strict";
import { test } from "node:test";

import { followPathPages, mentionSearchError, type PathPage } from "./mention-search.ts";

const nowait = async () => {};

test("a partial path page is not the final mention result", async () => {
  const pages: PathPage[] = [
    { paths: ["early.ts"], truncated: false, cancelled: false, ready: false },
    { paths: ["early.ts", "late.ts"], truncated: false, cancelled: false, ready: true },
  ];
  let index = 0;
  const seen: Array<{ paths: readonly string[]; ready: boolean }> = [];
  await followPathPages(
    async () => pages[index++]!,
    (page) => {
      seen.push({ paths: page.paths, ready: page.ready });
    },
    () => false,
    nowait,
  );
  assert.equal(index, 2);
  assert.deepEqual(seen, [
    { paths: ["early.ts"], ready: false },
    { paths: ["early.ts", "late.ts"], ready: true },
  ]);
});

test("a cancelled path page is not applied", async () => {
  let applied = 0;
  await followPathPages(
    async () => ({ paths: ["secret.ts"], truncated: false, cancelled: true, ready: true }),
    () => {
      applied += 1;
    },
    () => false,
    nowait,
  );
  assert.equal(applied, 0);
});

test("mention search hides opaque errors", () => {
  assert.equal(mentionSearchError(new Error("null")), "文件列表没有读到。");
  assert.equal(mentionSearchError("筛选没有完成"), "筛选没有完成");
  assert.equal(mentionSearchError({}), "文件列表没有读到。");
});
