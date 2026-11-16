import assert from "node:assert/strict";
import { test } from "node:test";

import type { Update, DownloadEvent } from "@tauri-apps/plugin-updater";
import { resetUpdaterForTest, type UpdaterRuntime } from "../../lib/native/updater.ts";
import {
  accountMenuUpdate,
  checkUpdates,
  closeUpdateDialog,
  countRunningSessions,
  dismissUpdate,
  getUpdateStateSnapshot,
  openOrCheckUpdates,
  openUpdateDialog,
  recheckUpdates,
  resetUpdateStoreForTest,
  retryUpdate,
  startDownload,
  startInstall,
  titlebarUpdatePill,
  type BusySessionTask,
} from "./update-store.ts";

function makeFakeUpdate(options: {
  version: string;
  body?: string;
  onDownload?: (emit: (event: DownloadEvent) => void) => Promise<void>;
  onInstall?: () => Promise<void>;
  onClose?: () => void;
}): Update {
  return {
    version: options.version,
    body: options.body ?? "• 修复若干问题",
    download: async (cb?: (event: DownloadEvent) => void) => {
      if (options.onDownload) {
        await options.onDownload((e) => cb?.(e));
      }
    },
    install: async () => {
      if (options.onInstall) {
        await options.onInstall();
      }
    },
    close: async () => {
      options.onClose?.();
    },
  } as unknown as Update;
}

test("startup check stays silent (no auto modal), surfaces titlebar pill & menu badge, and dismiss hides only the pill", async () => {
  await resetUpdaterForTest();
  resetUpdateStoreForTest();

  let checkCalls = 0;
  const runtime: UpdaterRuntime = {
    isDesktop: true,
    endpoint: () => "https://downloads.example.com/latest.json",
    checkRemote: async () => {
      checkCalls += 1;
      return makeFakeUpdate({ version: "0.2.91" });
    },
    relaunchApp: async () => {},
  };

  await checkUpdates(false, runtime);
  assert.equal(checkCalls, 1);
  assert.equal(getUpdateStateSnapshot().dialogOpen, false);
  assert.equal(getUpdateStateSnapshot().phase.kind, "available");
  assert.deepEqual(titlebarUpdatePill(getUpdateStateSnapshot()), {
    kind: "available",
    label: "新版本 v0.2.91",
  });
  assert.deepEqual(accountMenuUpdate(getUpdateStateSnapshot().phase, "0.2.90"), {
    checking: false,
    badge: "accent",
    label: "新版本 v0.2.91",
    meta: null,
  });

  openUpdateDialog();
  assert.equal(getUpdateStateSnapshot().dialogOpen, true);
  dismissUpdate();
  assert.equal(getUpdateStateSnapshot().dialogOpen, false);
  assert.equal(titlebarUpdatePill(getUpdateStateSnapshot()), null);
  assert.deepEqual(accountMenuUpdate(getUpdateStateSnapshot().phase, "0.2.90"), {
    checking: false,
    badge: "accent",
    label: "新版本 v0.2.91",
    meta: null,
  });

  // 侧栏菜单入口直接打开已有新版本弹窗，不重复拉取远端
  await openOrCheckUpdates(runtime);
  assert.equal(checkCalls, 1);
  assert.equal(getUpdateStateSnapshot().dialogOpen, true);
});

test("silent startup check failure resets to idle unless user opened dialog while check was in flight", async () => {
  await resetUpdaterForTest();
  resetUpdateStoreForTest();

  const failingRuntime: UpdaterRuntime = {
    isDesktop: true,
    endpoint: () => "https://downloads.example.com/latest.json",
    checkRemote: async () => {
      throw new Error("error sending request for url");
    },
    relaunchApp: async () => {},
  };

  await checkUpdates(false, failingRuntime);
  assert.equal(getUpdateStateSnapshot().dialogOpen, false);
  assert.deepEqual(getUpdateStateSnapshot().phase, { kind: "idle" });
  assert.equal(titlebarUpdatePill(getUpdateStateSnapshot()), null);
  assert.deepEqual(accountMenuUpdate(getUpdateStateSnapshot().phase, "0.2.90"), {
    checking: false,
    badge: null,
    label: "检查更新",
    meta: "v0.2.90",
  });

  // 启动静默检查进行中，用户点开菜单检查更新：不重复发起请求，且若随后报错应展示在已打开的弹窗里
  let rejectInFlight!: (err: Error) => void;
  let calls = 0;
  const inFlightRuntime: UpdaterRuntime = {
    isDesktop: true,
    endpoint: () => "https://downloads.example.com/latest.json",
    checkRemote: () => {
      calls += 1;
      return new Promise<Update | null>((_, reject) => {
        rejectInFlight = reject;
      });
    },
    relaunchApp: async () => {},
  };

  const bgPromise = checkUpdates(false, inFlightRuntime);
  await Promise.resolve();
  assert.equal(getUpdateStateSnapshot().phase.kind, "checking");
  assert.equal(getUpdateStateSnapshot().dialogOpen, false);

  await openOrCheckUpdates(inFlightRuntime);
  assert.equal(calls, 1);
  assert.equal(getUpdateStateSnapshot().dialogOpen, true);

  rejectInFlight(new Error("error sending request for url"));
  await bgPromise;
  assert.deepEqual(getUpdateStateSnapshot().phase, {
    kind: "error",
    stage: "check",
    message: "网络连接异常，无法检查更新。",
  });
});

test("two-stage download and install throttles sub-percent chunks and enters installing synchronously before install resolves", async () => {
  await resetUpdaterForTest();
  resetUpdateStoreForTest();

  let checkCalls = 0;
  let installCalls = 0;
  let relaunchCalls = 0;
  let closedHandles = 0;
  let finishDownload!: () => void;
  let finishInstall!: () => void;
  const downloadGate = new Promise<void>((resolve) => {
    finishDownload = resolve;
  });
  const installGate = new Promise<void>((resolve) => {
    finishInstall = resolve;
  });

  const runtime: UpdaterRuntime = {
    isDesktop: true,
    endpoint: () => "https://downloads.example.com/latest.json",
    checkRemote: async () => {
      checkCalls += 1;
      return makeFakeUpdate({
        version: "0.2.91",
        body: "• 支持顶栏胶囊提示",
        onClose: () => {
          closedHandles += 1;
        },
        onDownload: async (emit) => {
          emit({ event: "Started", data: { contentLength: 1000 } });
          // 连续发送未跨整百百分比的细碎分块，验证节流后仍准确跨入新百分比
          emit({ event: "Progress", data: { chunkLength: 1 } });
          emit({ event: "Progress", data: { chunkLength: 2 } });
          emit({ event: "Progress", data: { chunkLength: 447 } });
          await downloadGate;
          emit({ event: "Finished" });
        },
        onInstall: async () => {
          installCalls += 1;
          await installGate;
        },
      });
    },
    relaunchApp: async () => {
      relaunchCalls += 1;
    },
  };

  await checkUpdates(false, runtime);
  const downloadPromise = startDownload(runtime);
  await Promise.resolve();
  assert.deepEqual(getUpdateStateSnapshot().phase, {
    kind: "downloading",
    version: "0.2.91",
    notes: "• 支持顶栏胶囊提示",
    received: 450,
    total: 1000,
  });
  assert.deepEqual(titlebarUpdatePill(getUpdateStateSnapshot()), {
    kind: "downloading",
    label: "下载中 45%",
  });

  closeUpdateDialog();
  await checkUpdates(true, runtime);
  assert.equal(checkCalls, 1);
  assert.equal(getUpdateStateSnapshot().dialogOpen, true);
  assert.equal(getUpdateStateSnapshot().phase.kind, "downloading");

  await startDownload(runtime);
  finishDownload();
  await downloadPromise;

  assert.equal(installCalls, 0);
  assert.equal(relaunchCalls, 0);
  assert.deepEqual(getUpdateStateSnapshot().phase, {
    kind: "downloaded",
    version: "0.2.91",
    notes: "• 支持顶栏胶囊提示",
  });
  assert.deepEqual(titlebarUpdatePill(getUpdateStateSnapshot()), {
    kind: "downloaded",
    label: "重启以更新 v0.2.91",
  });

  // 已下载就绪时，命令面板触发 recheckUpdates 只打开弹窗，不丢弃已下载包
  closeUpdateDialog();
  await recheckUpdates(runtime);
  assert.equal(checkCalls, 1);
  assert.equal(getUpdateStateSnapshot().dialogOpen, true);
  assert.equal(getUpdateStateSnapshot().phase.kind, "downloaded");

  // 点击安装后，在 install() resolve 之前同步进入 installing 过渡态，防止界面闪回 downloaded
  const installPromise = startInstall(runtime);
  assert.deepEqual(getUpdateStateSnapshot().phase, {
    kind: "installing",
    version: "0.2.91",
  });
  assert.deepEqual(titlebarUpdatePill(getUpdateStateSnapshot()), {
    kind: "ready",
    label: "正在重启…",
  });

  finishInstall();
  await installPromise;
  assert.equal(installCalls, 1);
  assert.equal(relaunchCalls, 1);
  assert.equal(closedHandles, 1);
  assert.deepEqual(getUpdateStateSnapshot().phase, {
    kind: "ready",
    version: "0.2.91",
  });
});

test("download/install failures support both stage-isolated retry and recheckUpdates escape hatch when remote hotfixes", async () => {
  await resetUpdaterForTest();
  resetUpdateStoreForTest();

  let remoteVersion = "0.2.91";
  let checks = 0;
  let downloads = 0;
  let installs = 0;
  let closed = 0;
  const runtime: UpdaterRuntime = {
    isDesktop: true,
    endpoint: () => "https://downloads.example.com/latest.json",
    checkRemote: async () => {
      checks += 1;
      const ver = remoteVersion;
      return makeFakeUpdate({
        version: ver,
        onClose: () => {
          closed += 1;
        },
        onDownload: async () => {
          downloads += 1;
          if (ver === "0.2.91") {
            throw new Error("`Download request failed with status: 404 Not Found`");
          }
        },
        onInstall: async () => {
          installs += 1;
          if (installs === 1) {
            throw new Error("installer spawn error");
          }
        },
      });
    },
    relaunchApp: async () => {},
  };

  await checkUpdates(false, runtime);
  await startDownload(runtime);
  assert.deepEqual(getUpdateStateSnapshot().phase, {
    kind: "error",
    stage: "download",
    message: "下载更新包失败，请检查网络后重试。",
  });
  assert.deepEqual(titlebarUpdatePill(getUpdateStateSnapshot()), {
    kind: "error",
    label: "更新下载失败",
  });

  // 远端撤回损坏的 0.2.91 并发布热修 0.2.92：点击「重新检查」释放旧句柄并拉取到 0.2.92
  remoteVersion = "0.2.92";
  await recheckUpdates(runtime);
  assert.equal(closed, 1);
  assert.equal(checks, 2);
  const refreshed = getUpdateStateSnapshot().phase;
  assert.equal(refreshed.kind, "available");
  assert.equal(refreshed.version, "0.2.92");

  // 下载 0.2.92 成功，首次安装报错，随后直接重试安装（不重查、不重下）成功
  await startDownload(runtime);
  assert.equal(downloads, 2);
  assert.equal(getUpdateStateSnapshot().phase.kind, "downloaded");

  await startInstall(runtime);
  assert.equal(installs, 1);
  assert.deepEqual(getUpdateStateSnapshot().phase, {
    kind: "error",
    stage: "install",
    message: "更新未能完成，请稍后再试。",
  });

  await retryUpdate(runtime);
  assert.equal(checks, 2);
  assert.equal(downloads, 2);
  assert.equal(installs, 2);
  assert.deepEqual(getUpdateStateSnapshot().phase, {
    kind: "ready",
    version: "0.2.92",
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

test("relaunch failure after a finished install retries only the restart, never the download or check", async () => {
  await resetUpdaterForTest();
  resetUpdateStoreForTest();

  let checkCalls = 0;
  let downloads = 0;
  let installs = 0;
  let relaunches = 0;
  const runtime: UpdaterRuntime = {
    isDesktop: true,
    endpoint: () => "https://downloads.example.com/latest.json",
    checkRemote: async () => {
      checkCalls += 1;
      return makeFakeUpdate({
        version: "0.2.93",
        onDownload: async () => {
          downloads += 1;
        },
        onInstall: async () => {
          installs += 1;
        },
      });
    },
    relaunchApp: async () => {
      relaunches += 1;
      if (relaunches === 1) throw new Error("relaunch failed");
    },
  };

  await checkUpdates(true, runtime);
  await startDownload(runtime);
  await startInstall(runtime);
  assert.deepEqual(getUpdateStateSnapshot().phase, {
    kind: "error",
    stage: "restart",
    version: "0.2.93",
    message: "v0.2.93 已安装，自动重启没有成功，请重试或手动重启应用。",
  });

  closeUpdateDialog();
  await checkUpdates(true, runtime);
  assert.equal(checkCalls, 1);
  assert.equal(getUpdateStateSnapshot().dialogOpen, true);
  assert.equal(getUpdateStateSnapshot().phase.kind, "error");

  await retryUpdate(runtime);
  assert.equal(relaunches, 2);
  assert.equal(installs, 1);
  assert.equal(downloads, 1);
  assert.equal(checkCalls, 1);
  assert.deepEqual(getUpdateStateSnapshot().phase, { kind: "ready", version: "0.2.93" });
});
