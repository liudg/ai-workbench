// 从 tauri build 产物校验签名、生成 Tauri updater 的 latest.json，并把安装包同步到 release/。
//
// 用法：
//   node scripts/gen-latest-json.mjs \
//     --url https://github.com/liudg/ai-workbench/releases/download/v0.2.87 \
//     [--tag v0.2.87] [--notes "更新说明"] [--bundle target/release/bundle/nsis] \
//     [--out release/latest.json]
//
// 在 GitHub Actions 中可省略 --url/--notes/--tag，自动取环境变量与 Git 历史。

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { resolveReleaseTag } from "./check-release-version.mjs";
import {
  copyLatestInstaller,
  findInstallerArtifact,
  releaseAssetName,
} from "./copy-installer.mjs";
import { verifyMinisignSignature } from "./minisign.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function runGit(args, cwd) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

export function deriveReleaseNotes({ rootDir = root, tag, version } = {}) {
  const tagRef = tag && !tag.startsWith("-") ? `refs/tags/${tag}` : "";
  if (tagRef) {
    const objType = runGit(
      ["for-each-ref", "--format=%(objecttype)", tagRef],
      rootDir,
    );
    if (objType === "tag") {
      // 使用 subject + body，自动剥离 GPG / SSH 签名块
      const subject = runGit(
        ["for-each-ref", "--format=%(contents:subject)", tagRef],
        rootDir,
      );
      const body = runGit(
        ["for-each-ref", "--format=%(contents:body)", tagRef],
        rootDir,
      );
      const annotation = [subject, body].filter(Boolean).join("\n\n").trim();
      if (annotation) return annotation;
    }
  }

  const verifiedTag =
    tagRef && runGit(["rev-parse", "--verify", "--quiet", tagRef], rootDir)
      ? tagRef
      : "HEAD";
  const prevTag = runGit(
    ["describe", "--tags", "--abbrev=0", "--match", "v*", `${verifiedTag}^`],
    rootDir,
  );
  if (prevTag) {
    const rawLog = runGit(
      ["log", `${prevTag}..${verifiedTag}`, "--no-merges", "--pretty=format:%s", "--"],
      rootDir,
    );
    const lines = rawLog
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !/^chore(\([^)]*\))?:\s*(bump|release)\b/i.test(line));
    if (lines.length > 0) {
      return lines.map((line) => `• ${line}`).join("\n");
    }
  }

  return `v${version} 版本更新`;
}

export function generateLatestJson({
  rootDir = root,
  bundleDir = join(rootDir, "target", "release", "bundle", "nsis"),
  outPath = join(rootDir, "release", "latest.json"),
  baseUrl,
  tag,
  notes,
  pubDate = new Date().toISOString(),
  env = process.env,
} = {}) {
  const conf = JSON.parse(
    readFileSync(join(rootDir, "src-tauri", "tauri.conf.json"), "utf8"),
  );
  const version = conf.version;
  const pubkey = conf.plugins?.updater?.pubkey?.trim();
  if (!pubkey) {
    throw new Error("src-tauri/tauri.conf.json 缺少 plugins.updater.pubkey，无法验证安装包签名");
  }

  const resolvedTag = resolveReleaseTag({ explicitTag: tag, env, version });
  const resolvedBaseUrl =
    baseUrl ||
    (env.GITHUB_REPOSITORY
      ? `https://github.com/${env.GITHUB_REPOSITORY}/releases/download/${resolvedTag}`
      : null);
  if (!resolvedBaseUrl) {
    throw new Error("缺少 --url（或 GITHUB_REPOSITORY 环境变量）");
  }

  const resolvedNotes =
    notes?.trim() ||
    env.RELEASE_NOTES?.trim() ||
    deriveReleaseNotes({ rootDir, tag: resolvedTag, version });

  const { artifact } = findInstallerArtifact({
    bundleDir,
    version,
    requireSignature: true,
  });
  const installerBuffer = readFileSync(join(bundleDir, artifact));
  const signature = readFileSync(join(bundleDir, `${artifact}.sig`), "utf8").trim();

  // 离线验证安装包字节与 .sig 签名确由 tauri.conf.json 内嵌公钥对应的私钥签发，且版本号一致
  verifyMinisignSignature({
    dataBuffer: installerBuffer,
    sigContent: signature,
    pubkeyInput: pubkey,
    expectedVersion: version,
  });

  const releaseArtifact = releaseAssetName(artifact);
  const latest = {
    version,
    notes: resolvedNotes,
    pub_date: pubDate,
    platforms: {
      "windows-x86_64": {
        signature,
        url: `${resolvedBaseUrl.replace(/\/$/, "")}/${encodeURIComponent(releaseArtifact)}`,
      },
    },
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(latest, null, 2) + "\n");
  copyLatestInstaller({
    rootDir,
    bundleDir,
    releaseDir: dirname(outPath),
    artifact,
  });
  return { latest, artifact, releaseArtifact, outPath, tag: resolvedTag };
}

const isDirectRun =
  process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  try {
    const { values } = parseArgs({
      options: {
        bundle: { type: "string" },
        out: { type: "string" },
        url: { type: "string" },
        tag: { type: "string" },
        notes: { type: "string" },
      },
      strict: true,
    });
    const result = generateLatestJson({
      bundleDir: values.bundle ?? join(root, "target", "release", "bundle", "nsis"),
      outPath: values.out ?? join(root, "release", "latest.json"),
      baseUrl: values.url,
      tag: values.tag,
      notes: values.notes,
    });
    console.log(`已生成并完成离线验签：${result.outPath}`);
    console.log(`  version: ${result.latest.version}  artifact: ${result.releaseArtifact}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
