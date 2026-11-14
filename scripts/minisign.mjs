// 纯 Node.js 内置 crypto 实现的 Tauri / Minisign 公钥、私钥信封校验与离线签名验证。
// 算法与 tauri-plugin-updater 所用的 minisign-verify 保持严格一致：
// - 公钥：42 字节 = 2 字节算法 ("Ed" / "ED") + 8 字节 keyId + 32 字节 Ed25519 公钥
// - 签名：74 字节 bin1 (2 字节算法 + 8 字节 keyId + 64 字节签名) + trusted comment + 64 字节全局签名

import { createHash, createPublicKey, verify } from "node:crypto";

// ASN.1 DER SubjectPublicKeyInfo 固定前缀（Ed25519 OID 1.3.101.112）
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function decodeBase64Strict(input, label) {
  const trimmed = input.trim();
  if (!trimmed || !/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed) || trimmed.length % 4 !== 0) {
    throw new Error(`${label} 不是合法的 Base64 字符串`);
  }
  return Buffer.from(trimmed, "base64");
}

/**
 * 若输入是 Tauri 配置里整段文件再 Base64 编码的单行文本，则先解出一层 UTF-8 多行文本；
 * 若本身已是 `untrusted comment: ...` 多行文本，则直接返回。
 */
function unwrapMinisignText(raw, label) {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(`${label} 为空`);
  }
  if (trimmed.startsWith("untrusted comment:")) {
    return trimmed;
  }
  const decoded = decodeBase64Strict(trimmed, label).toString("utf8").trim();
  if (!decoded.startsWith("untrusted comment:")) {
    throw new Error(`${label} 解码后缺少 minisign "untrusted comment:" 头部`);
  }
  return decoded;
}

export function decodeMinisignPublicKey(pubkeyInput) {
  const text = unwrapMinisignText(pubkeyInput, "updater.pubkey");
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) {
    throw new Error("updater.pubkey 格式不完整（缺少公钥数据行）");
  }
  const bin = decodeBase64Strict(lines[1], "updater.pubkey 数据行");
  if (bin.length !== 42) {
    throw new Error(`updater.pubkey 长度应为 42 字节，实际为 ${bin.length} 字节`);
  }
  const alg0 = bin[0];
  const alg1 = bin[1];
  if (alg0 !== 0x45 || (alg1 !== 0x64 && alg1 !== 0x44)) {
    throw new Error("updater.pubkey 算法标识不是 Ed25519 (Ed/ED)");
  }
  const keyId = Buffer.from(bin.subarray(2, 10));
  const rawKey = Buffer.from(bin.subarray(10, 42));
  const keyObject = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, rawKey]),
    format: "der",
    type: "spki",
  });
  return {
    untrustedComment: lines[0],
    keyId,
    keyIdHex: Buffer.from(keyId).reverse().toString("hex").toUpperCase(),
    rawKey,
    keyObject,
  };
}

export function validateMinisignSecretKeyFormat(secretKeyInput) {
  const text = unwrapMinisignText(secretKeyInput, "TAURI_SIGNING_PRIVATE_KEY");
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) {
    throw new Error("TAURI_SIGNING_PRIVATE_KEY 格式不完整（缺少密钥数据行）");
  }
  const bin = decodeBase64Strict(lines[1], "TAURI_SIGNING_PRIVATE_KEY 数据行");
  if (bin.length !== 158) {
    throw new Error(
      `TAURI_SIGNING_PRIVATE_KEY 长度应为 158 字节（可能误填了公钥或截断），实际为 ${bin.length} 字节`,
    );
  }
  if (bin[0] !== 0x45 || bin[1] !== 0x64) {
    throw new Error("TAURI_SIGNING_PRIVATE_KEY 算法头部不是合法的 minisign Ed25519 私钥");
  }
  return true;
}

function decodeMinisignSignature(sigInput) {
  const text = unwrapMinisignText(sigInput, ".sig 签名");
  const lines = text.split(/\r?\n/);
  if (lines.length < 4) {
    throw new Error(".sig 签名内容不足 4 行");
  }
  const bin1 = decodeBase64Strict(lines[1], ".sig 第一段签名");
  if (bin1.length !== 74) {
    throw new Error(`.sig 第一段长度应为 74 字节，实际为 ${bin1.length} 字节`);
  }
  const trustedLine = lines[2];
  if (!trustedLine.startsWith("trusted comment: ")) {
    throw new Error(".sig 缺少合法的 trusted comment 行");
  }
  const globalSignature = decodeBase64Strict(lines[3], ".sig 全局签名");
  if (globalSignature.length !== 64) {
    throw new Error(`.sig 全局签名长度应为 64 字节，实际为 ${globalSignature.length} 字节`);
  }

  let isPrehashed;
  if (bin1[0] === 0x45 && bin1[1] === 0x64) {
    isPrehashed = false;
  } else if (bin1[0] === 0x45 && bin1[1] === 0x44) {
    isPrehashed = true;
  } else {
    throw new Error(".sig 签名算法不受支持");
  }

  const keyId = Buffer.from(bin1.subarray(2, 10));
  const signature = Buffer.from(bin1.subarray(10, 74));
  const trustedComment = trustedLine.slice("trusted comment: ".length);
  const signedVersion =
    trustedComment
      .split("\t")
      .find((field) => field.startsWith("version:"))
      ?.slice("version:".length) ?? null;

  return {
    untrustedComment: lines[0],
    keyId,
    keyIdHex: Buffer.from(keyId).reverse().toString("hex").toUpperCase(),
    signature,
    trustedComment,
    signedVersion,
    globalSignature,
    isPrehashed,
  };
}

export function verifyMinisignSignature({
  dataBuffer,
  sigContent,
  pubkeyInput,
  expectedVersion,
}) {
  const pub = decodeMinisignPublicKey(pubkeyInput);
  const sig = decodeMinisignSignature(sigContent);

  if (!pub.keyId.equals(sig.keyId)) {
    throw new Error(
      `签名密钥不匹配：安装包签名 Key ID (${sig.keyIdHex}) 与 tauri.conf.json 公钥 Key ID (${pub.keyIdHex}) 不一致，请检查 TAURI_SIGNING_PRIVATE_KEY`,
    );
  }

  const payload = sig.isPrehashed
    ? createHash("blake2b512").update(dataBuffer).digest()
    : dataBuffer;

  if (!verify(null, payload, pub.keyObject, sig.signature)) {
    throw new Error("安装包 minisign 内容签名校验失败（安装包已被修改或公私钥不匹配）");
  }

  const globalPayload = Buffer.concat([
    sig.signature,
    Buffer.from(sig.trustedComment, "utf8"),
  ]);
  if (!verify(null, globalPayload, pub.keyObject, sig.globalSignature)) {
    throw new Error("安装包 minisign trusted comment 全局签名校验失败");
  }

  if (expectedVersion && sig.signedVersion) {
    const cleanSigned = sig.signedVersion.replace(/^v/, "");
    const cleanExpected = expectedVersion.replace(/^v/, "");
    if (cleanSigned !== cleanExpected) {
      throw new Error(
        `签名内嵌版本 (${sig.signedVersion}) 与预期版本 (${expectedVersion}) 不一致`,
      );
    }
  }

  return { keyIdHex: pub.keyIdHex, signedVersion: sig.signedVersion };
}
