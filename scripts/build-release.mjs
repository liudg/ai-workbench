// 完整发布打包：编译 daemon sidecar → tauri build → 复制最新 NSIS 安装包到 release/。
// 本地未配置 TAURI_SIGNING_PRIVATE_KEY（且非 CI）时，自动关闭 createUpdaterArtifacts，
// 并清理同版本残留的旧 .sig，避免未签名安装包与过期签名混用；CI 环境仍强制要求签名。

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildDaemon } from "./build-daemon.mjs";
import { copyLatestInstaller } from "./copy-installer.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const tauriCli = require.resolve("@tauri-apps/cli/tauri.js");
const rawArgs = process.argv.slice(2);
const skipCopy = rawArgs.includes("--skip-copy");
const extraArgs = rawArgs.filter((a) => a !== "--skip-copy");

buildDaemon({ rootDir: root });

const args = [tauriCli, "build", "--config", "src-tauri/tauri.release.json"];
const hasSigningKey = Boolean(process.env.TAURI_SIGNING_PRIVATE_KEY?.trim());
const isCi = Boolean(
  process.env.CI && process.env.CI !== "0" && process.env.CI !== "false",
);
const unsignedLocal = !hasSigningKey && !isCi;
if (unsignedLocal) {
  console.log("未设置 TAURI_SIGNING_PRIVATE_KEY，本地构建跳过自动更新签名");
  args.push(
    "--config",
    JSON.stringify({ bundle: { createUpdaterArtifacts: false } }),
  );
}
args.push(...extraArgs);

execFileSync(process.execPath, args, { cwd: root, stdio: "inherit" });

if (unsignedLocal) {
  const conf = JSON.parse(
    readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"),
  );
  const bundleDir = join(root, "target", "release", "bundle", "nsis");
  if (existsSync(bundleDir)) {
    for (const name of readdirSync(bundleDir)) {
      if (name.includes(`_${conf.version}_`) && name.endsWith(".sig")) {
        rmSync(join(bundleDir, name), { force: true });
      }
    }
  }
}

if (!skipCopy && !extraArgs.includes("--no-bundle") && process.platform === "win32") {
  copyLatestInstaller({ rootDir: root });
}
