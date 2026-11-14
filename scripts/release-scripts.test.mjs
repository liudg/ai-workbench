import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { checkReleaseVersion, resolveReleaseTag } from "./check-release-version.mjs";
import { releaseAssetName } from "./copy-installer.mjs";
import { deriveReleaseNotes, generateLatestJson } from "./gen-latest-json.mjs";
import { decodeMinisignPublicKey, verifyMinisignSignature } from "./minisign.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 生成一对用于测试的真实 Ed25519 minisign 公钥与对指定数据的合法签名。 */
function createTestMinisignFixture({
  dataBuffer,
  version = "0.2.87",
  keyId = Buffer.from("0102030405060708", "hex"),
}) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  const rawPub = spki.subarray(spki.length - 32);

  // 公钥 42 字节: "Ed" (0x45 0x64) + keyId (8) + rawPub (32)
  const pubBin = Buffer.concat([Buffer.from([0x45, 0x64]), keyId, rawPub]);
  const pubText = `untrusted comment: minisign public key\n${pubBin.toString("base64")}\n`;
  const pubkeyBase64 = Buffer.from(pubText, "utf8").toString("base64");

  // Prehashed ("ED" = 0x45 0x44) 签名
  const digest = createHash("blake2b512").update(dataBuffer).digest();
  const sigBytes = sign(null, digest, privateKey);
  const bin1 = Buffer.concat([Buffer.from([0x45, 0x44]), keyId, sigBytes]);
  const trustedComment = `timestamp:1794659223\tfile:test.exe\tversion:${version}`;
  const globalSig = sign(
    null,
    Buffer.concat([sigBytes, Buffer.from(trustedComment, "utf8")]),
    privateKey,
  );
  const sigText = [
    "untrusted comment: signature from tauri secret key",
    bin1.toString("base64"),
    `trusted comment: ${trustedComment}`,
    globalSig.toString("base64"),
  ].join("\n");
  const sigBase64 = Buffer.from(sigText, "utf8").toString("base64");

  return { pubkeyBase64, sigBase64 };
}

test("repository versions, updater pubkey, and endpoints pass release validation", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const res = checkReleaseVersion({ rootDir: root, env: {} });
  assert.equal(res.version, pkg.version);
  assert.equal(res.tag, `v${pkg.version}`);
  assert.equal(res.pubkeyId, "20DE90D7FCDBA830");
  assert.equal(
    res.endpoint,
    "https://github.com/liudg/ai-workbench/releases/latest/download/latest.json",
  );

  assert.throws(
    () => checkReleaseVersion({ rootDir: root, tag: "v0.0.1", env: {} }),
    /不一致/,
  );
  assert.throws(
    () =>
      checkReleaseVersion({
        rootDir: root,
        requireSigningKey: true,
        env: { TAURI_SIGNING_PRIVATE_KEY: "   " },
      }),
    /TAURI_SIGNING_PRIVATE_KEY/,
  );
});

test("minisign verifier validates real Ed25519/Blake2b signatures and rejects key mismatch or tampering", () => {
  const data = Buffer.from("nsis-installer-binary-payload");
  const { pubkeyBase64, sigBase64 } = createTestMinisignFixture({
    dataBuffer: data,
    version: "0.2.87",
  });

  const pub = decodeMinisignPublicKey(pubkeyBase64);
  assert.equal(pub.rawKey.length, 32);

  const ok = verifyMinisignSignature({
    dataBuffer: data,
    sigContent: sigBase64,
    pubkeyInput: pubkeyBase64,
    expectedVersion: "0.2.87",
  });
  assert.equal(ok.signedVersion, "0.2.87");

  // 篡改安装包内容应拒绝
  assert.throws(
    () =>
      verifyMinisignSignature({
        dataBuffer: Buffer.from("tampered-payload"),
        sigContent: sigBase64,
        pubkeyInput: pubkeyBase64,
        expectedVersion: "0.2.87",
      }),
    /签名校验失败/,
  );

  // 版本号不匹配应拒绝
  assert.throws(
    () =>
      verifyMinisignSignature({
        dataBuffer: data,
        sigContent: sigBase64,
        pubkeyInput: pubkeyBase64,
        expectedVersion: "0.2.88",
      }),
    /版本/,
  );

  // 不同密钥签发（Key ID 不一致）应拒绝
  const other = createTestMinisignFixture({
    dataBuffer: data,
    keyId: Buffer.from("1111111111111111", "hex"),
  });
  assert.throws(
    () =>
      verifyMinisignSignature({
        dataBuffer: data,
        sigContent: other.sigBase64,
        pubkeyInput: pubkeyBase64,
      }),
    /Key ID/,
  );
});

test("resolveReleaseTag ignores branch names even when branch starts with v", () => {
  assert.equal(
    resolveReleaseTag({
      env: { GITHUB_REF_TYPE: "branch", GITHUB_REF_NAME: "main" },
      version: "0.2.87",
    }),
    "v0.2.87",
  );
  assert.equal(
    resolveReleaseTag({
      env: { GITHUB_REF_TYPE: "branch", GITHUB_REF_NAME: "v2" },
      version: "0.2.87",
    }),
    "v0.2.87",
  );
  assert.equal(
    resolveReleaseTag({
      env: { GITHUB_REF_TYPE: "branch", GITHUB_REF_NAME: "v0.2.0-dev" },
      version: "0.2.87",
    }),
    "v0.2.87",
  );
  assert.equal(
    resolveReleaseTag({
      env: { GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v0.2.87" },
      version: "0.2.87",
    }),
    "v0.2.87",
  );
});

test("generateLatestJson verifies signature and sanitizes spaced NSIS installer names", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "aiwb-release-test-"));
  try {
    const installerPayload = Buffer.from("installer-bytes-v0.2.87");
    const { pubkeyBase64, sigBase64 } = createTestMinisignFixture({
      dataBuffer: installerPayload,
      version: "0.2.87",
    });

    mkdirSync(join(sandbox, "src-tauri"), { recursive: true });
    writeFileSync(
      join(sandbox, "src-tauri", "tauri.conf.json"),
      JSON.stringify({
        version: "0.2.87",
        plugins: { updater: { pubkey: pubkeyBase64 } },
      }),
    );

    const bundleDir = join(sandbox, "target", "release", "bundle", "nsis");
    const releaseDir = join(sandbox, "release");
    mkdirSync(bundleDir, { recursive: true });
    mkdirSync(releaseDir, { recursive: true });

    writeFileSync(join(releaseDir, "AI Workbench_0.2.86_x64-setup.exe"), "old");
    writeFileSync(join(bundleDir, "AI Workbench_0.2.87_x64-setup.exe"), installerPayload);
    writeFileSync(join(bundleDir, "AI Workbench_0.2.87_x64-setup.exe.sig"), `${sigBase64}\n`);

    const outPath = join(releaseDir, "latest.json");
    const result = generateLatestJson({
      rootDir: sandbox,
      bundleDir,
      outPath,
      notes: "• 新增自动更新流水线",
      pubDate: "2026-11-15T00:00:00.000Z",
      env: {
        GITHUB_REPOSITORY: "liudg/ai-workbench",
        GITHUB_REF_TYPE: "tag",
        GITHUB_REF_NAME: "v0.2.87",
      },
    });

    assert.equal(
      releaseAssetName("AI Workbench_0.2.87_x64-setup.exe"),
      "AI-Workbench_0.2.87_x64-setup.exe",
    );
    assert.equal(result.releaseArtifact, "AI-Workbench_0.2.87_x64-setup.exe");
    assert.equal(existsSync(join(releaseDir, "AI-Workbench_0.2.87_x64-setup.exe")), true);
    assert.equal(existsSync(join(releaseDir, "AI-Workbench_0.2.87_x64-setup.exe.sig")), true);
    assert.equal(existsSync(join(releaseDir, "AI Workbench_0.2.86_x64-setup.exe")), false);

    const latest = JSON.parse(readFileSync(outPath, "utf8"));
    assert.deepEqual(latest, {
      version: "0.2.87",
      notes: "• 新增自动更新流水线",
      pub_date: "2026-11-15T00:00:00.000Z",
      platforms: {
        "windows-x86_64": {
          signature: sigBase64,
          url: "https://github.com/liudg/ai-workbench/releases/download/v0.2.87/AI-Workbench_0.2.87_x64-setup.exe",
        },
      },
    });
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("deriveReleaseNotes handles first tag fallback, commit ranges, and annotated tags", () => {
  const repo = mkdtempSync(join(tmpdir(), "aiwb-git-notes-"));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: repo,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
      stdio: "ignore",
    });

  try {
    git("init");
    writeFileSync(join(repo, "a.txt"), "1");
    git("add", ".");
    git("commit", "-m", "feat: initial");
    git("tag", "v0.1.0");

    // 首个 tag 没有任何前置 v* tag，平稳回退到默认文案
    assert.equal(
      deriveReleaseNotes({ rootDir: repo, tag: "v0.1.0", version: "0.1.0" }),
      "v0.1.0 版本更新",
    );

    writeFileSync(join(repo, "a.txt"), "2");
    git("commit", "-am", "fix: 修复窗口闪烁");
    writeFileSync(join(repo, "a.txt"), "3");
    git("commit", "-am", "chore: bump to 0.1.1");
    git("tag", "v0.1.1");

    // 轻量 tag 提取 v0.1.0..v0.1.1 提交，并自动过滤 chore: bump
    assert.equal(
      deriveReleaseNotes({ rootDir: repo, tag: "v0.1.1", version: "0.1.1" }),
      "• fix: 修复窗口闪烁",
    );

    writeFileSync(join(repo, "a.txt"), "4");
    git("commit", "-am", "feat: 支持离线验签");
    git("tag", "-a", "v0.1.2", "-m", "v0.1.2 重点更新\n\n新增离线验签保护");

    // 附注 tag 直接读取 subject + body
    assert.equal(
      deriveReleaseNotes({ rootDir: repo, tag: "v0.1.2", version: "0.1.2" }),
      "v0.1.2 重点更新\n\n新增离线验签保护",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
