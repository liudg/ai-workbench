// 把当前版本的 NSIS 安装包复制到仓库 release/，并只保留这一份。
//
// 用法：
//   node scripts/copy-installer.mjs
//   node scripts/copy-installer.mjs --bundle target/release/bundle/nsis
//
// `pnpm tauri:build` 和 `scripts/gen-latest-json.mjs` 都会调用这里。
// 安装包不入库（见 .gitignore 的 release/*.exe）。

import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function isInstaller(name) {
  return (
    name.endsWith("_x64-setup.exe") ||
    name.endsWith("_x64-setup.exe.sig") ||
    name.endsWith(".nsis.zip") ||
    name.endsWith(".nsis.zip.sig")
  );
}

export function copyLatestInstaller({
  rootDir = root,
  bundleDir = join(root, "target", "release", "bundle", "nsis"),
  releaseDir = join(root, "release"),
} = {}) {
  const conf = JSON.parse(
    readFileSync(join(rootDir, "src-tauri", "tauri.conf.json"), "utf8"),
  );
  const version = conf.version;
  const files = readdirSync(bundleDir);
  const artifact = files.find(
    (name) => name.includes(`_${version}_`) && name.endsWith("_x64-setup.exe"),
  );
  if (!artifact) {
    throw new Error(
      `在 ${bundleDir} 未找到 AI Workbench_${version}_x64-setup.exe，请先运行 pnpm tauri:build`,
    );
  }

  mkdirSync(releaseDir, { recursive: true });
  const keep = new Set([artifact]);
  copyFileSync(join(bundleDir, artifact), join(releaseDir, artifact));
  const signature = `${artifact}.sig`;
  if (files.includes(signature)) {
    copyFileSync(join(bundleDir, signature), join(releaseDir, signature));
    keep.add(signature);
  }

  for (const name of readdirSync(releaseDir)) {
    if (isInstaller(name) && !keep.has(name)) {
      rmSync(join(releaseDir, name));
    }
  }

  const dest = join(releaseDir, artifact);
  console.log(`已复制安装包到 ${dest}`);
  return dest;
}

const isDirectRun =
  process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  try {
    copyLatestInstaller({
      bundleDir: arg(
        "bundle",
        join(root, "target", "release", "bundle", "nsis"),
      ),
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
