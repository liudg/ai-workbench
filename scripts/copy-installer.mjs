// 把当前版本的 NSIS 安装包（及签名）复制到仓库 release/，并只保留这一份。
// 复制到 release/ 时将文件名中的空格替换为连字符（如 AI-Workbench_0.2.87_x64-setup.exe），
// 避免上传到 GitHub Release 时被重命名而与 latest.json 的下载 URL 不一致。
//
// 用法：
//   node scripts/copy-installer.mjs [--bundle target/release/bundle/nsis]
//
// 安装包不入库（见 .gitignore 的 release/*.exe）。

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function releaseAssetName(filename) {
  return filename.trim().replace(/\s+/g, "-");
}

function isInstaller(name) {
  return (
    name.endsWith("_x64-setup.exe") ||
    name.endsWith("_x64-setup.exe.sig") ||
    name.endsWith(".nsis.zip") ||
    name.endsWith(".nsis.zip.sig")
  );
}

export function findInstallerArtifact({
  bundleDir,
  version,
  requireSignature = false,
}) {
  if (!existsSync(bundleDir)) {
    throw new Error(`产物目录不存在：${bundleDir}，请先运行 pnpm tauri:build`);
  }
  const files = readdirSync(bundleDir);
  const match = (suffix) =>
    files.find(
      (name) =>
        name.includes(`_${version}_`) &&
        name.endsWith(suffix) &&
        (!requireSignature || files.includes(`${name}.sig`)),
    );
  const artifact = match("_x64-setup.exe") || match("_x64-setup.nsis.zip");
  if (!artifact) {
    const kind = requireSignature ? "已签名的 " : "";
    throw new Error(
      `在 ${bundleDir} 未找到${kind}*_${version}_x64-setup.exe（或 .nsis.zip），请先运行 pnpm tauri:build`,
    );
  }
  return { artifact, files };
}

export function copyLatestInstaller({
  rootDir = root,
  bundleDir = join(rootDir, "target", "release", "bundle", "nsis"),
  releaseDir = join(rootDir, "release"),
  artifact: explicitArtifact,
} = {}) {
  const conf = JSON.parse(
    readFileSync(join(rootDir, "src-tauri", "tauri.conf.json"), "utf8"),
  );
  const version = conf.version;
  const { artifact, files } = explicitArtifact
    ? { artifact: explicitArtifact, files: readdirSync(bundleDir) }
    : findInstallerArtifact({ bundleDir, version, requireSignature: false });

  mkdirSync(releaseDir, { recursive: true });
  const targetArtifact = releaseAssetName(artifact);
  const keep = new Set([targetArtifact]);
  copyFileSync(join(bundleDir, artifact), join(releaseDir, targetArtifact));

  const signature = `${artifact}.sig`;
  if (files.includes(signature)) {
    const targetSignature = `${targetArtifact}.sig`;
    copyFileSync(join(bundleDir, signature), join(releaseDir, targetSignature));
    keep.add(targetSignature);
  }

  for (const name of readdirSync(releaseDir)) {
    if (isInstaller(name) && !keep.has(name)) {
      rmSync(join(releaseDir, name));
    }
  }

  const dest = join(releaseDir, targetArtifact);
  console.log(`已复制安装包到 ${dest}`);
  return dest;
}

const isDirectRun =
  process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  try {
    const { values } = parseArgs({
      options: {
        bundle: { type: "string" },
      },
      strict: true,
    });
    copyLatestInstaller({
      bundleDir: values.bundle ?? join(root, "target", "release", "bundle", "nsis"),
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
