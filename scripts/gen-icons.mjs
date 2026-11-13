// 生成应用图标（「协同光轨 · 曜石黑底」，零第三方依赖，预乘 Alpha 超采样 + 多尺寸 ICO）
// 用法: node scripts/gen-icons.mjs
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const iconsDir = join(root, "src-tauri", "icons");
const publicDir = join(root, "public");
mkdirSync(iconsDir, { recursive: true });
mkdirSync(publicDir, { recursive: true });

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function sdRoundedBox(px, py, cx, cy, hx, hy, r) {
  const qx = Math.abs(px - cx) - (hx - r);
  const qy = Math.abs(py - cy) - (hy - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function sdCircle(px, py, cx, cy, r) {
  return Math.hypot(px - cx, py - cy) - r;
}

function linearGrad(px, py, x0, y0, x1, y1, c0, c1) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const t = clamp01(((px - x0) * dx + (py - y0) * dy) / (dx * dx + dy * dy));
  return [
    c0[0] + (c1[0] - c0[0]) * t,
    c0[1] + (c1[1] - c0[1]) * t,
    c0[2] + (c1[2] - c0[2]) * t,
  ];
}

function blendOver(dstR, dstG, dstB, srcR, srcG, srcB, alpha) {
  if (alpha <= 0) return [dstR, dstG, dstB];
  if (alpha >= 1) return [srcR, srcG, srcB];
  const inv = 1 - alpha;
  return [dstR * inv + srcR * alpha, dstG * inv + srcG * alpha, dstB * inv + srcB * alpha];
}

// 在 64x64 设计网格上用解析距离场平滑采样
function sampleDesign(px, py, aaWidth) {
  const outerDist = sdRoundedBox(px, py, 32, 32, 30, 30, 15);
  const outerAlpha = clamp01(0.5 - outerDist / aaWidth);
  if (outerAlpha <= 0) return [0, 0, 0, 0];

  // 曜石对角渐变底色 (#1d2233 -> #0a0c12)
  let [r, g, b] = linearGrad(px, py, 8, 4, 56, 60, [29, 34, 51], [10, 12, 18]);

  // 顶部微光内描边（上亮下暗的细微高光边，避免厚重灰框）
  const innerRingDist = Math.abs(sdRoundedBox(px, py, 32, 32, 29.6, 29.6, 14.6)) - 0.4;
  const lightFade = clamp01(1 - (py - 2) / 56);
  const ringCov = clamp01(0.5 - innerRingDist / aaWidth) * (0.04 + 0.14 * lightFade);
  [r, g, b] = blendOver(r, g, b, 255, 255, 255, ringCov);

  // 上轨左胶囊 (#f1f4fa) 与右电光蓝节点 (#7da0ff)
  const topBarCov = clamp01(0.5 - sdRoundedBox(px, py, 25, 19, 11, 3.5, 3.5) / aaWidth);
  [r, g, b] = blendOver(r, g, b, 241, 244, 250, topBarCov);

  const topDotCov = clamp01(0.5 - sdCircle(px, py, 45.5, 19, 4) / aaWidth);
  [r, g, b] = blendOver(r, g, b, 125, 160, 255, topDotCov);

  // 中轴协同主光轨 (#94afff -> #5e81ff)
  const midCov = clamp01(0.5 - sdRoundedBox(px, py, 32, 32, 18, 3.5, 3.5) / aaWidth);
  if (midCov > 0) {
    const [mr, mg, mb] = linearGrad(px, py, 14, 28, 50, 36, [148, 175, 255], [94, 129, 255]);
    [r, g, b] = blendOver(r, g, b, mr, mg, mb, midCov);
  }

  // 下轨左灵动紫节点 (#a78bfa) 与右胶囊 (#f1f4fa)
  const botDotCov = clamp01(0.5 - sdCircle(px, py, 18.5, 45, 4) / aaWidth);
  [r, g, b] = blendOver(r, g, b, 167, 139, 250, botDotCov);

  const botBarCov = clamp01(0.5 - sdRoundedBox(px, py, 39, 45, 11, 3.5, 3.5) / aaWidth);
  [r, g, b] = blendOver(r, g, b, 241, 244, 250, botBarCov);

  return [r, g, b, outerAlpha];
}

function renderIconPng(size) {
  const grid = size <= 64 ? 8 : 4;
  const scale = 64 / size;
  const aaWidth = scale / grid;
  const raw = Buffer.alloc((size * 4 + 1) * size);

  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < size; x++) {
      let pr = 0;
      let pg = 0;
      let pb = 0;
      let pa = 0;
      for (let sy = 0; sy < grid; sy++) {
        const py = (y + (sy + 0.5) / grid) * scale;
        for (let sx = 0; sx < grid; sx++) {
          const px = (x + (sx + 0.5) / grid) * scale;
          const [sr, sg, sb, sa] = sampleDesign(px, py, aaWidth);
          pr += sr * sa;
          pg += sg * sa;
          pb += sb * sa;
          pa += sa;
        }
      }
      const samples = grid * grid;
      const o = rowStart + 1 + x * 4;
      if (pa <= 0) {
        raw[o] = 0;
        raw[o + 1] = 0;
        raw[o + 2] = 0;
        raw[o + 3] = 0;
      } else {
        raw[o] = Math.round(pr / pa);
        raw[o + 1] = Math.round(pg / pa);
        raw[o + 2] = Math.round(pb / pa);
        raw[o + 3] = Math.round((pa / samples) * 255);
      }
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function encodeIco(frames) {
  const count = frames.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // ICO
  header.writeUInt16LE(count, 4);

  const dir = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  frames.forEach(({ size, png }, idx) => {
    const base = idx * 16;
    dir[base] = size >= 256 ? 0 : size;
    dir[base + 1] = size >= 256 ? 0 : size;
    dir[base + 2] = 0;
    dir[base + 3] = 0;
    dir.writeUInt16LE(1, base + 4);
    dir.writeUInt16LE(32, base + 6);
    dir.writeUInt32BE(0, base + 8);
    dir.writeUInt32LE(png.length, base + 8);
    dir.writeUInt32LE(offset, base + 12);
    offset += png.length;
  });

  return Buffer.concat([header, dir, ...frames.map((f) => f.png)]);
}

const pngCache = new Map();
function getPng(size) {
  if (!pngCache.has(size)) pngCache.set(size, renderIconPng(size));
  return pngCache.get(size);
}

for (const [name, size] of [
  ["32x32.png", 32],
  ["128x128.png", 128],
  ["256x256.png", 256],
  ["icon.png", 512],
]) {
  writeFileSync(join(iconsDir, name), getPng(size));
  console.log(`written src-tauri/icons/${name}`);
}

const icoSizes = [16, 24, 32, 48, 64, 256];
writeFileSync(
  join(iconsDir, "icon.ico"),
  encodeIco(icoSizes.map((size) => ({ size, png: getPng(size) }))),
);
console.log(`written src-tauri/icons/icon.ico (${icoSizes.join(", ")}px)`);

writeFileSync(join(publicDir, "favicon.png"), getPng(64));
console.log("written public/favicon.png");
