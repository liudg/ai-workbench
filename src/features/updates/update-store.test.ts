import assert from "node:assert/strict";
import { test } from "node:test";

import type { Update, DownloadEvent } from "@tauri-apps/plugin-updater";
import { resetUpdaterForTest, type UpdaterRuntime } from "../../lib/native/updater.ts";
import {
  checkUpdates,
  closeUpdateDialog,
  countRunningSessions,
  getUpdateStateSnapshot,
  resetUpdateStoreForTest,
  retryUpdate,
  startInstall,
  type BusySessionTask,
} from "./update-store.ts";

function makeFakeUpdate(options: {
  version: string;
  body?: string;
  onDownload?: (emit: (event: DownloadEvent) => void) => Promise<void>;
  onClose?: () => void;
}): Update {
  return {
    version: options.version,
    body: options.body ?? "• 修复若干问题",
    downloadAndInstall: async (cb?: (event: DownloadEvent) => void) => {
      if (options.onDownload) {
        await options.onDownload((e) => cb?.(e));
      }
    },
    close: async () => {
      options.onClose?.();
    },
  } as unknown as Update;
}

test("manual checkUpdates during active download reopens dialog without clobbering progress or re-checking", async () => {
  await resetUpdaterForTest();
  resetUpdateStoreForTest();

  let checkCalls = 0;
  let closedHandles = 0;
  let finishDownload!: () => void;
  const downloadGate = new Promise<void>((resolve) => {
    finishDownload = resolve;
  });

  const runtime: UpdaterRuntime = {
    isDesktop: true,
    endpoint: () => "https://downloads.example.com/latest.json",
    checkRemote: async () => {
      checkCalls += 1;
      return makeFakeUpdate({
        version: "0.2.88",
        onClose: () => {
          closedHandles += 1;
        },
        onDownload: async (emit) => {
          emit({ event: "Started", data: { contentLength: 100 } });
          emit({ event: "Progress", data: { chunkLength: 45 } });
          await downloadGate;
          emit({ event: "Finished" });
        },
      });
    },
    relaunchApp: async () => {},
  };

  await checkUpdates(false, runtime);
  assert.equal(checkCalls, 1);
  assert.equal(getUpdateStateSnapshot().dialogOpen, true);
  assert.equal(getUpdateStateSnapshot().phase.kind, "available");

  const installPromise = startInstall(runtime);
  await Promise.resolve();
  assert.deepEqual(getUpdateStateSnapshot().phase, {
    kind: "downloading",
    received: 45,
    total: 100,
  });

  // 用户关掉弹窗后又从侧栏点「检查更新」：应只把弹窗重新打开，保持 45/100 进度，且不再调 checkRemote
  closeUpdateDialog();
  assert.equal(getUpdateStateSnapshot().dialogOpen, false);

  await checkUpdates(true, runtime);
  assert.equal(checkCalls, 1);
  assert.equal(getUpdateStateSnapshot().dialogOpen, true);
  assert.deepEqual(getUpdateStateSnapshot().phase, {
    kind: "downloading",
    received: 45,
    total: 100,
  });

  // 并发再次点 startInstall 也必须被互斥锁拦截
  await startInstall(runtime);
  finishDownload();
  await installPromise;

  assert.deepEqual(getUpdateStateSnapshot().phase, {
    kind: "ready",
    version: "0.2.88",
  });
  assert.equal(closedHandles, 1);
});

test("install failure preserves pending update so retryUpdate retries install instead of losing handle", async () => {
  await resetUpdaterForTest();
  resetUpdateStoreForTest();

  let attempts = 0;
  const runtime: UpdaterRuntime = {
    isDesktop: true,
    endpoint: () => "https://downloads.example.com/latest.json",
    checkRemote: async () =>
      makeFakeUpdate({
        version: "0.2.89",
        onDownload: async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("`Download request failed with status: 502 Bad Gateway`");
          }
        },
      }),
    relaunchApp: async () => {},
  };

  await checkUpdates(true, runtime);
  await startInstall(runtime);
  assert.deepEqual(getUpdateStateSnapshot().phase, {
    kind: "error",
    stage: "install",
    message: "下载更新包失败，请检查网络后重试。",
  });

  await retryUpdate(runtime);
  assert.equal(attempts, 2);
  assert.deepEqual(getUpdateStateSnapshot().phase, {
    kind: "ready",
    version: "0.2.89",
  });
});

test("countRunningSessions counts starting, running, and needs-input across main and side sessions", () => {
  const tasks = [
    {
      sessions: [{ status: "running" }, { status: "completed" }],
      sides: [{ status: "needs-input" }, { status: "stopped" }],
    },
    {
      sessions: [{ status: "starting" }, { status: "failed" }],
    },
  ] satisfies BusySessionTask[];

  assert.equal(countRunningSessions(tasks), 3);
});
