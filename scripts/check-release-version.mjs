// 发布前快速校验：
// 1. package.json / Cargo.toml / src-tauri/Cargo.toml / src-tauri/tauri.conf.json 四处版本号一致且为合法 SemVer；
// 2. 若由 v* tag 触发（或传入 --tag），tag 必须等于 v<version>；
// 3. tauri.conf.json 与 src/lib/native/update-source.ts 的更新源一致，且 pubkey 为合法的 minisign Ed25519 公钥；
// 4. 传入 --require-signing-key 时检查 TAURI_SIGNING_PRIVATE_KEY 格式合法；
// 5. 传入 --verify-keypair 时在临时文件上执行一次真实签名 + 公钥离线验签，确保公私钥严格成对；
// 6. 传入 --require-tag-at-head 时，若 v<version> tag 已存在，它必须指向当前提交，避免覆盖已发布版本。

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import {
  decodeMinisignPublicKey,
  validateMinisignSecretKeyFormat,
  verifyMinisignSignature,
} from "./minisign.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function readTomlSectionVersion(tomlText, sectionHeader) {
  const lines = tomlText.split(/\r?\n/);
  let inSection = false;
  for (const raw of lines) {
    const withoutComment = raw.replace(/#.*$/, "").trim();
    if (!withoutComment) continue;
    if (withoutComment.startsWith("[")) {
      inSection = withoutComment === sectionHeader;
      continue;
    }
    if (inSection) {
      const m = withoutComment.match(/^version\s*=\s*["']([^"']+)["']/);
      if (m) return m[1];
    }
  }
  return null;
}

export function resolveReleaseTag({ explicitTag, env = process.env, version }) {
  if (explicitTag !== undefined) {
    const trimmed = explicitTag.trim();
    if (!trimmed) {
      throw new Error("--tag 参数值不能为空");
    }
    return trimmed;
  }
  if (env.RELEASE_TAG?.trim()) return env.RELEASE_TAG.trim();
  if (env.GITHUB_REF_TYPE === "tag" && env.GITHUB_REF_NAME?.trim()) {
    return env.GITHUB_REF_NAME.trim();
  }
  return `v${version}`;
}

function gitRevParse(rootDir, rev) {
  try {
    return execFileSync("git", ["rev-parse", "--verify", "--quiet", rev], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

/** tag 已存在却不指向当前提交时拒绝发布：同一个版本号只能对应一份源码。 */
export function assertTagAtHead({ rootDir = root, tag }) {
  const head = gitRevParse(rootDir, "HEAD^{commit}");
  if (!head) {
    throw new Error("读不到当前提交，无法确认 tag 指向（需要在 Git 仓库内运行）");
  }
  const tagged = gitRevParse(rootDir, `refs/tags/${tag}^{commit}`);
  if (tagged && tagged !== head) {
    throw new Error(
      `tag ${tag} 已存在并指向 ${tagged.slice(0, 7)}，当前提交是 ${head.slice(0, 7)}；请先升版本号再发布，不要覆盖已发布的版本`,
    );
  }
}

function verifySigningKeypairWithCli({
  rootDir = root,
  pubkey,
  version,
  env = process.env,
}) {
  const require = createRequire(join(rootDir, "package.json"));
  const tauriCli = require.resolve("@tauri-apps/cli/tauri.js");
  const sandbox = mkdtempSync(join(tmpdir(), "aiwb-keycheck-"));
  try {
    const probePath = join(sandbox, "probe.bin");
    const probeBytes = Buffer.from(`aiwb-keycheck-${version}`, "utf8");
    writeFileSync(probePath, probeBytes);
    execFileSync(process.execPath, [tauriCli, "signer", "sign", probePath], {
      cwd: rootDir,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const sigRaw = readFileSync(`${probePath}.sig`, "utf8").trim();
    verifyMinisignSignature({
      dataBuffer: probeBytes,
      sigContent: sigRaw,
      pubkeyInput: pubkey,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`签名公私钥配对自检失败：${detail}`);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

export function checkReleaseVersion({
  rootDir = root,
  tag,
  requireSigningKey = false,
  verifyKeypair = false,
  requireTagAtHead = false,
  env = process.env,
} = {}) {
  const pkg = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
  const workspaceCargo = readFileSync(join(rootDir, "Cargo.toml"), "utf8");
  const tauriCargo = readFileSync(join(rootDir, "src-tauri", "Cargo.toml"), "utf8");
  const tauriConf = JSON.parse(
    readFileSync(join(rootDir, "src-tauri", "tauri.conf.json"), "utf8"),
  );
  const updateSource = readFileSync(
    join(rootDir, "src", "lib", "native", "update-source.ts"),
    "utf8",
  );

  const versions = {
    "package.json": pkg.version,
    "Cargo.toml": readTomlSectionVersion(workspaceCargo, "[workspace.package]"),
    "src-tauri/Cargo.toml": readTomlSectionVersion(tauriCargo, "[package]"),
    "src-tauri/tauri.conf.json": tauriConf.version,
  };

  const unique = new Set(Object.values(versions));
  if (unique.size !== 1 || !pkg.version) {
    const detail = Object.entries(versions)
      .map(([file, ver]) => `  ${file}: ${ver ?? "<未找到>"}`)
      .join("\n");
    throw new Error(`四处版本号不一致：\n${detail}`);
  }

  const version = pkg.version;
  if (!SEMVER_RE.test(version)) {
    throw new Error(`版本号 "${version}" 不是合法的 SemVer（不应带 v 前缀）`);
  }

  const expectedTag = `v${version}`;
  const effectiveTag = resolveReleaseTag({ explicitTag: tag, env, version });
  if (effectiveTag !== expectedTag) {
    throw new Error(
      `Git tag (${effectiveTag}) 与代码版本号 (${expectedTag}) 不一致，请先同步更新版本号后再打 tag`,
    );
  }

  if (requireTagAtHead) {
    assertTagAtHead({ rootDir, tag: effectiveTag });
  }

  const pubkey = tauriConf.plugins?.updater?.pubkey?.trim();
  if (!pubkey) {
    throw new Error("src-tauri/tauri.conf.json 缺少 plugins.updater.pubkey");
  }
  const decodedPub = decodeMinisignPublicKey(pubkey);

  const endpoints = tauriConf.plugins?.updater?.endpoints ?? [];
  if (!Array.isArray(endpoints) || endpoints.length === 0 || !endpoints[0]?.startsWith("https://")) {
    throw new Error("src-tauri/tauri.conf.json 缺少有效的 plugins.updater.endpoints");
  }

  const sourceMatch = updateSource.match(/UPDATE_ENDPOINT\s*=\s*["']([^"']*)["']/m);
  if (!sourceMatch || sourceMatch[1] !== endpoints[0]) {
    throw new Error(
      "src/lib/native/update-source.ts 的 UPDATE_ENDPOINT 与 src-tauri/tauri.conf.json 的 endpoints[0] 不一致",
    );
  }

  if (requireSigningKey || verifyKeypair) {
    const secret = env.TAURI_SIGNING_PRIVATE_KEY?.trim();
    if (!secret) {
      throw new Error(
        "缺少 TAURI_SIGNING_PRIVATE_KEY，请在 GitHub 仓库 Settings → Secrets and variables → Actions 中配置签名私钥",
      );
    }
    validateMinisignSecretKeyFormat(secret);
  }

  if (verifyKeypair) {
    verifySigningKeypairWithCli({ rootDir, pubkey, version, env });
  }

  return {
    version,
    tag: effectiveTag,
    endpoint: endpoints[0],
    pubkeyId: decodedPub.keyIdHex,
  };
}

const isDirectRun =
  process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  try {
    const { values } = parseArgs({
      options: {
        tag: { type: "string" },
        "github-output": { type: "string" },
        "require-signing-key": { type: "boolean", default: false },
        "verify-keypair": { type: "boolean", default: false },
        "require-tag-at-head": { type: "boolean", default: false },
      },
      strict: true,
    });
    const result = checkReleaseVersion({
      tag: values.tag,
      requireSigningKey: values["require-signing-key"],
      verifyKeypair: values["verify-keypair"],
      requireTagAtHead: values["require-tag-at-head"],
    });
    if (values["github-output"]) {
      appendFileSync(
        values["github-output"],
        `version=${result.version}\ntag=${result.tag}\n`,
      );
    }
    console.log(
      `版本校验通过：${result.tag} (pubkey: ${result.pubkeyId}, endpoint: ${result.endpoint})`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
