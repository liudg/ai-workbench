// 生成应用图标（无需任何第三方依赖，手写 PNG 编码器）
// 用法: node scripts/gen-icons.mjs
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "src-tauri", "icons");
mkdirSync(outDir, { recursive: true });

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

function encodePng(size, pixelAt) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelAt(x / size, y / size);
      const o = rowStart + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// 圆角方形：靛蓝 → 青色对角渐变，中央一个高亮"终端光标"竖条
function iconPixel(u, v) {
  const radius = 0.22;
  const dx = Math.max(Math.abs(u - 0.5) - (0.5 - radius), 0);
  const dy = Math.max(Math.abs(v - 0.5) - (0.5 - radius), 0);
  if (Math.hypot(dx, dy) > radius) return [0, 0, 0, 0];

  const t = Math.min(1, Math.max(0, (u + v) / 2));
  const r = Math.round(79 + (34 - 79) * t);
  const g = Math.round(70 + (211 - 70) * t);
  const b = Math.round(229 + (238 - 229) * t);

  // 光标竖条（终端提示符意象）
  const inBar = u > 0.3 && u < 0.42 && v > 0.3 && v < 0.7;
  const inDash = u > 0.52 && u < 0.72 && v > 0.62 && v < 0.7;
  if (inBar || inDash) return [255, 255, 255, 235];
  return [r, g, b, 255];
}

for (const [name, size] of [
  ["32x32.png", 32],
  ["128x128.png", 128],
  ["256x256.png", 256],
  ["icon.png", 512],
]) {
  writeFileSync(join(outDir, name), encodePng(size, iconPixel));
  console.log(`written src-tauri/icons/${name}`);
}
