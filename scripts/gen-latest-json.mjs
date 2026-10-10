// 从 tauri build 产物生成 Tauri updater 的 latest.json。
//
// 用法：
//   node scripts/gen-latest-json.mjs \
//     --url https://github.com/OWNER/REPO/releases/download/v0.1.1 \
//     [--notes "更新说明"] [--bundle src-tauri/target/release/bundle/nsis] \
//     [--out release/latest.json]
//
// 在 GitHub Actions 中可省略 --url/--notes/--tag，自动取 GITHUB_* 环境变量。

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const conf = JSON.parse(
  readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"),
);
const version = conf.version;
const tag = arg("tag", process.env.GITHUB_REF_NAME || `v${version}`);
const baseUrl = arg(
  "url",
  process.env.GITHUB_REPOSITORY
    ? `https://github.com/${process.env.GITHUB_REPOSITORY}/releases/download/${tag}`
    : null,
);
if (!baseUrl) {
  console.error("缺少 --url（或 GITHUB_REPOSITORY 环境变量）");
  process.exit(1);
}

const bundleDir = arg(
  "bundle",
  join(root, "src-tauri", "target", "release", "bundle", "nsis"),
);
const notes = arg("notes", process.env.RELEASE_NOTES || `v${version} 版本更新`);

// 产物命名由 tauri 决定：<productName>_<version>_<arch>-setup.nsis.zip(.sig)
const files = readdirSync(bundleDir);
const zip = files.find((f) => f.endsWith("_x64-setup.nsis.zip"));
if (!zip) {
  console.error(`在 ${bundleDir} 未找到 *_x64-setup.nsis.zip，请先运行 pnpm tauri build`);
  process.exit(1);
}
const sigFile = files.find((f) => f === `${zip}.sig`);
if (!sigFile) {
  console.error(`未找到签名文件 ${zip}.sig（构建时缺少 TAURI_SIGNING_PRIVATE_KEY？）`);
  process.exit(1);
}
const signature = readFileSync(join(bundleDir, sigFile), "utf8").trim();

const latest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature,
      url: `${baseUrl}/${zip}`,
    },
  },
};

const out = arg("out", join(root, "release", "latest.json"));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(latest, null, 2) + "\n");
console.log(`已生成 ${out}`);
console.log(`  version: ${version}  artifact: ${zip}`);
