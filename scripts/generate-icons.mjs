// Generates the extension icons (public/icons/icon-<size>.png) without any
// image dependencies: flat white glyphs on a solid squircle.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), "../public/icons");
const SIZES = [16, 32, 48, 128];

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
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
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Flat design in a unit square [0,1]². Three variants:
// - "app":     extension icon (coral, speaker + X)
// - "muted":   toolbar icon for a muted tab (same as app)
// - "unmuted": toolbar icon for an audible tab (teal, speaker + sound waves)
const VARIANTS = {
  app: { bg: [249, 84, 91], glyph: "cross" },
  muted: { bg: [249, 84, 91], glyph: "cross" },
  unmuted: { bg: [20, 160, 140], glyph: "waves" },
};
const FG = [255, 255, 255];

function insideRoundedSquare(x, y, r) {
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
function insideSpeaker(x, y) {
  if (x >= 0.16 && x <= 0.32 && y >= 0.38 && y <= 0.62) return true; // body
  if (x >= 0.3 && x <= 0.54) {
    const half = 0.12 + ((x - 0.3) / 0.24) * 0.2; // cone widens to the right
    return Math.abs(y - 0.5) <= half;
  }
  return false;
}
function insideCross(x, y) {
  const u = x - 0.73;
  const v = y - 0.5;
  if (Math.abs(u) > 0.12 || Math.abs(v) > 0.12) return false;
  const w = 0.055;
  return Math.abs(u - v) / Math.SQRT2 <= w || Math.abs(u + v) / Math.SQRT2 <= w;
}
function insideWaves(x, y) {
  // Two concentric arcs to the right of the speaker cone.
  const cx = 0.5;
  const dx = x - cx;
  const dy = y - 0.5;
  if (dx <= 0 || Math.abs(Math.atan2(dy, dx)) > Math.PI / 4) return false;
  const d = Math.hypot(dx, dy);
  return Math.abs(d - 0.14) <= 0.04 || Math.abs(d - 0.3) <= 0.04;
}

function makeShade(variant) {
  const { bg, glyph } = VARIANTS[variant];
  const insideGlyph = glyph === "cross" ? insideCross : insideWaves;
  return (x, y) => {
    if (!insideRoundedSquare(x, y, 0.24)) return null;
    return insideSpeaker(x, y) || insideGlyph(x, y) ? FG : bg;
  };
}

function render(size, shade) {
  const rgba = Buffer.alloc(size * size * 4);
  const SS = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const acc = [0, 0, 0];
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const color = shade((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size);
          if (!color) continue;
          hits++;
          for (let c = 0; c < 3; c++) acc[c] += color[c];
        }
      }
      if (hits === 0) continue;
      const i = (py * size + px) * 4;
      for (let c = 0; c < 3; c++) rgba[i + c] = Math.round(acc[c] / hits);
      rgba[i + 3] = Math.round((255 * hits) / (SS * SS));
    }
  }
  return encodePng(size, rgba);
}

const OUTPUTS = [
  ...SIZES.map((size) => ({ variant: "app", size, file: `icon-${size}.png` })),
  ...[16, 32].flatMap((size) => [
    { variant: "muted", size, file: `action-muted-${size}.png` },
    { variant: "unmuted", size, file: `action-unmuted-${size}.png` },
  ]),
];

mkdirSync(outDir, { recursive: true });
for (const { variant, size, file } of OUTPUTS) {
  writeFileSync(resolve(outDir, file), render(size, makeShade(variant)));
  console.log(`wrote icons/${file}`);
}
