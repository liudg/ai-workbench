// 完整发布打包：编译 daemon sidecar → tauri build → 复制最新 NSIS 安装包到 release/。
// 本地未配置 TAURI_SIGNING_PRIVATE_KEY（且非 CI）时，自动关闭 createUpdaterArtifacts，
// 并清理同版本残留的旧 .sig，避免未签名安装包与过期签名混用；CI 环境仍强制要求签名。

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildDaemon } from "./build-daemon.mjs";
import { copyLatestInstaller } from "./copy-installer.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const tauriCli = require.resolve("@tauri-apps/cli/tauri.js");

/**
 * 解析打包参数：兼容 `pnpm run tauri:build -- ...` 透传的首个 `--` 分隔符，
 * 避免 `--bundles` 等 Tauri CLI 选项被误当作 `--` 之后的 `cargo build` 参数。
 */
export function parseBuildReleaseArgs(rawArgs = []) {
  const normalized = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
  const runnerSep = normalized.indexOf("--");
  const cliArgs = runnerSep === -1 ? normalized : normalized.slice(0, runnerSep);
  const runnerArgs = runnerSep === -1 ? [] : normalized.slice(runnerSep);
  const skipCopy = cliArgs.includes("--skip-copy");
  const noBundle = cliArgs.includes("--no-bundle");
  const extraArgs = [
    ...cliArgs.filter((arg) => arg !== "--skip-copy"),
    ...runnerArgs,
  ];
  return { skipCopy, noBundle, extraArgs };
}

export function runBuildRelease({
  rootDir = root,
  rawArgs = process.argv.slice(2),
  env = process.env,
} = {}) {
  const { skipCopy, noBundle, extraArgs } = parseBuildReleaseArgs(rawArgs);

  buildDaemon({ rootDir });

  const args = [tauriCli, "build", "--config", "src-tauri/tauri.release.json"];
  const hasSigningKey = Boolean(env.TAURI_SIGNING_PRIVATE_KEY?.trim());
  const isCi = Boolean(env.CI && env.CI !== "0" && env.CI !== "false");
  const unsignedLocal = !hasSigningKey && !isCi;
  if (unsignedLocal) {
    console.log("未设置 TAURI_SIGNING_PRIVATE_KEY，本地构建跳过自动更新签名");
    args.push(
      "--config",
      JSON.stringify({ bundle: { createUpdaterArtifacts: false } }),
    );
  }
  args.push(...extraArgs);

  execFileSync(process.execPath, args, { cwd: rootDir, env, stdio: "inherit" });

  if (unsignedLocal) {
    const conf = JSON.parse(
      readFileSync(join(rootDir, "src-tauri", "tauri.conf.json"), "utf8"),
    );
    const bundleDir = join(rootDir, "target", "release", "bundle", "nsis");
    if (existsSync(bundleDir)) {
      for (const name of readdirSync(bundleDir)) {
        if (name.includes(`_${conf.version}_`) && name.endsWith(".sig")) {
          rmSync(join(bundleDir, name), { force: true });
        }
      }
    }
  }

  if (!skipCopy && !noBundle && process.platform === "win32") {
    copyLatestInstaller({ rootDir });
  }
}

const isDirectRun =
  process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  runBuildRelease();
}
