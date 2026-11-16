import assert from "node:assert/strict";
import { test } from "node:test";

import { downloadProgress } from "./update-store.ts";

test("下载开始时进度条保持零并显示准备状态", () => {
  for (const total of [null, 0]) {
    assert.deepEqual(downloadProgress(0, total), {
      width: "0%",
      text: "准备下载…",
    });
  }
  assert.deepEqual(downloadProgress(0, 4096), {
    width: "0%",
    text: "0 KB / 4 KB",
  });
});

test("总大小未知时展示实际下载量，取得总大小后展示实际比例", () => {
  for (const total of [null, 0]) {
    assert.deepEqual(downloadProgress(1024, total), {
      width: "0%",
      text: "已下载 1 KB",
    });
  }
  assert.deepEqual(downloadProgress(1024, 4096), {
    width: "25%",
    text: "1 KB / 4 KB",
  });
  assert.deepEqual(downloadProgress(4096, 4096), {
    width: "100%",
    text: "4 KB / 4 KB",
  });
});

test("进度条宽度最多为百分之百，重新下载从零开始", () => {
  assert.equal(downloadProgress(5120, 4096).width, "100%");
  assert.deepEqual(downloadProgress(0, null), {
    width: "0%",
    text: "准备下载…",
  });
});
