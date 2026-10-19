// Post-build: write manifest.json and icons into dist/.
// Final artwork comes from ../assets/icons; until it exists we draw a placeholder.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");
const artwork = resolve(root, "../assets/icons");
const SIZES = [16, 32, 48, 128];

const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(resolve(root, "src/manifest.json"), "utf8"));
manifest.version = pkg.version;
writeFileSync(resolve(dist, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

mkdirSync(resolve(dist, "icons"), { recursive: true });
let placeholders = 0;
for (const size of SIZES) {
  const src = resolve(artwork, `icon-${size}.png`);
  const dest = resolve(dist, `icons/icon-${size}.png`);
  if (existsSync(src)) copyFileSync(src, dest);
  else {
    writeFileSync(dest, placeholderIcon(size));
    placeholders++;
  }
}
console.log(`dist/manifest.json written; icons: ${SIZES.length - placeholders} artwork, ${placeholders} placeholder`);

// ---- placeholder: graphite squircle with a white ring and a dot (a "port") ----

function placeholderIcon(n) {
  const px = Buffer.alloc(n * n * 4);
  const ss = 4; // supersampling
  const c = n / 2;
  const radius = n * 0.22;
  const ringOuter = n * 0.30;
  const ringInner = n * 0.21;
  const dot = n * 0.085;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let bg = 0, fg = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px_ = x + (sx + 0.5) / ss, py = y + (sy + 0.5) / ss;
          if (insideRoundRect(px_, py, n, radius)) {
            bg++;
            const d = Math.hypot(px_ - c, py - c);
            if ((d <= ringOuter && d >= ringInner) || d <= dot) fg++;
          }
        }
      }
      const total = ss * ss;
      const a = bg / total, f = bg ? fg / bg : 0;
      const g = Math.round(0x2c + (0xff - 0x2c) * f);
      const i = (y * n + x) * 4;
      px[i] = g; px[i + 1] = g; px[i + 2] = Math.min(255, g + (f ? 0 : 2));
      px[i + 3] = Math.round(a * 255);
    }
  }
  return encodePng(n, n, px);
}

function insideRoundRect(x, y, n, r) {
  const cx = Math.min(Math.max(x, r), n - r);
  const cy = Math.min(Math.max(y, r), n - r);
  return Math.hypot(x - cx, y - cy) <= r;
}

function encodePng(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
