// A small QR Code encoder (ISO/IEC 18004, byte mode, all 40 versions), so "Open on Phone"
// works offline with no third-party code. Follows the structure of Project Nayuki's
// reference implementation (MIT). Output is a matrix of dark/light modules.

export type Ecc = "L" | "M" | "Q" | "H";

const ECC_INDEX: Record<Ecc, number> = { L: 0, M: 1, Q: 2, H: 3 };
const FORMAT_BITS: Record<Ecc, number> = { L: 1, M: 0, Q: 3, H: 2 };

// Indexed [ecc][version]; index 0 is unused.
const ECC_CODEWORDS_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const NUM_ERROR_CORRECTION_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

const bit = (x: number, i: number) => ((x >>> i) & 1) !== 0;

function alignmentPositions(ver: number): number[] {
  if (ver === 1) return [];
  const size = ver * 4 + 17;
  const n = Math.floor(ver / 7) + 2;
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
  const out = [6];
  for (let pos = size - 7; out.length < n; pos -= step) out.splice(1, 0, pos);
  return out;
}

function rawDataModules(ver: number): number {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const n = Math.floor(ver / 7) + 2;
    r -= (25 * n - 10) * n - 55;
    if (ver >= 7) r -= 36;
  }
  return r;
}

function dataCodewords(ver: number, ecc: Ecc): number {
  const e = ECC_INDEX[ecc];
  return Math.floor(rawDataModules(ver) / 8) - ECC_CODEWORDS_PER_BLOCK[e]![ver]! * NUM_ERROR_CORRECTION_BLOCKS[e]![ver]!;
}

// ---- Reed-Solomon over GF(2^8) / 0x11D ----

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree: number): number[] {
  const out = new Array<number>(degree).fill(0);
  out[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < out.length; j++) {
      out[j] = gfMul(out[j]!, root);
      if (j + 1 < out.length) out[j]! ^= out[j + 1]!;
    }
    root = gfMul(root, 0x02);
  }
  return out;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const out = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ out.shift()!;
    out.push(0);
    divisor.forEach((c, i) => (out[i]! ^= gfMul(c, factor)));
  }
  return out;
}

function withEcc(data: number[], ver: number, ecc: Ecc): number[] {
  const e = ECC_INDEX[ecc];
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[e]![ver]!;
  const eccLen = ECC_CODEWORDS_PER_BLOCK[e]![ver]!;
  const raw = Math.floor(rawDataModules(ver) / 8);
  const numShort = numBlocks - (raw % numBlocks);
  const shortLen = Math.floor(raw / numBlocks);
  const div = rsDivisor(eccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
    k += dat.length;
    const rem = rsRemainder(dat, div);
    if (i < numShort) dat.push(0);
    blocks.push(dat.concat(rem));
  }
  const out: number[] = [];
  for (let i = 0; i < blocks[0]!.length; i++) {
    blocks.forEach((b, j) => {
      if (i !== shortLen - eccLen || j >= numShort) out.push(b[i]!);
    });
  }
  return out;
}

// ---- matrix ----

class Grid {
  readonly size: number;
  readonly dark: boolean[][];
  readonly fn: boolean[][];
  constructor(readonly ver: number) {
    this.size = ver * 4 + 17;
    this.dark = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.fn = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }
  set(x: number, y: number, dark: boolean) {
    this.dark[y]![x] = dark;
    this.fn[y]![x] = true;
  }
}

function drawFunctionPatterns(g: Grid) {
  const { size } = g;
  for (let i = 0; i < size; i++) {
    g.set(6, i, i % 2 === 0);
    g.set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]] as const) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        g.set(x, y, d !== 2 && d !== 4);
      }
    }
  }
  const pos = alignmentPositions(g.ver);
  const n = pos.length;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) g.set(pos[i]! + dx, pos[j]! + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }
  drawFormat(g, "M", 0); // reserve; overwritten once the mask is chosen
  if (g.ver >= 7) {
    let rem = g.ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (g.ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      g.set(a, b, bit(bits, i));
      g.set(b, a, bit(bits, i));
    }
  }
}

function drawFormat(g: Grid, ecc: Ecc, mask: number) {
  const data = (FORMAT_BITS[ecc] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const { size } = g;
  for (let i = 0; i <= 5; i++) g.set(8, i, bit(bits, i));
  g.set(8, 7, bit(bits, 6));
  g.set(8, 8, bit(bits, 7));
  g.set(7, 8, bit(bits, 8));
  for (let i = 9; i < 15; i++) g.set(14 - i, 8, bit(bits, i));
  for (let i = 0; i < 8; i++) g.set(size - 1 - i, 8, bit(bits, i));
  for (let i = 8; i < 15; i++) g.set(8, size - 15 + i, bit(bits, i));
  g.set(8, size - 8, true);
}

function drawCodewords(g: Grid, data: number[]) {
  const { size } = g;
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!g.fn[y]![x] && i < data.length * 8) {
          g.dark[y]![x] = bit(data[i >>> 3]!, 7 - (i & 7));
          i++;
        }
      }
    }
  }
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(g: Grid, mask: number) {
  const f = MASKS[mask]!;
  for (let y = 0; y < g.size; y++) {
    for (let x = 0; x < g.size; x++) if (!g.fn[y]![x] && f(x, y)) g.dark[y]![x] = !g.dark[y]![x];
  }
}

/** The standard's penalty score: lower means easier for scanners. */
function penalty(m: boolean[][]): number {
  const n = m.length;
  let score = 0;
  const line = (get: (i: number) => boolean) => {
    let run = 1;
    for (let i = 1; i <= n; i++) {
      if (i < n && get(i) === get(i - 1)) run++;
      else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    // Finder-like 1:1:3:1:1 with four light modules on either side.
    for (let i = 0; i + 11 <= n; i++) {
      const s = Array.from({ length: 11 }, (_, k) => get(i + k));
      const core = s[4] && !s[5] && s[6] && s[7] && s[8] && !s[9] && s[10];
      const a = !s[0] && !s[1] && !s[2] && !s[3] && core;
      const b = s[0] && !s[1] && s[2] && s[3] && s[4] && !s[5] && s[6] && !s[7] && !s[8] && !s[9] && !s[10];
      if (a || b) score += 40;
    }
  };
  for (let y = 0; y < n; y++) line((x) => m[y]![x]!);
  for (let x = 0; x < n; x++) line((y) => m[y]![x]!);
  let dark = 0;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (m[y]![x]) dark++;
      if (x + 1 < n && y + 1 < n) {
        const c = m[y]![x];
        if (c === m[y]![x + 1] && c === m[y + 1]![x] && c === m[y + 1]![x + 1]) score += 3;
      }
    }
  }
  const total = n * n;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

/** Encode `text` (UTF-8, byte mode) at the smallest version that fits. */
export function encodeQr(text: string, ecc: Ecc = "M"): boolean[][] {
  const bytes = [...new TextEncoder().encode(text)];
  let ver = 1;
  for (; ver <= 40; ver++) {
    const ccBits = ver <= 9 ? 8 : 16;
    if (4 + ccBits + bytes.length * 8 <= dataCodewords(ver, ecc) * 8) break;
  }
  if (ver > 40) throw new RangeError("text too long for a QR code");

  const bits: number[] = [];
  const push = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  const capacity = dataCodewords(ver, ecc) * 8;
  push(0, Math.min(4, capacity - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(""), 2));

  const g = new Grid(ver);
  drawFunctionPatterns(g);
  drawCodewords(g, withEcc(data, ver, ecc));
  let best = -1;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(g, mask);
    drawFormat(g, ecc, mask);
    const s = penalty(g.dark);
    if (s < bestScore) {
      best = mask;
      bestScore = s;
    }
    applyMask(g, mask); // XOR again to undo
  }
  applyMask(g, best);
  drawFormat(g, ecc, best);
  return g.dark;
}

/**
 * An SVG of the code with the standard four-module quiet zone. Dark modules are merged
 * into horizontal runs so the path stays small; crispEdges keeps them sharp at any scale.
 */
export function qrSvg(text: string, { size = 168, ecc = "M" as Ecc, label = "" } = {}): string {
  const m = encodeQr(text, ecc);
  const quiet = 4;
  const dim = m.length + quiet * 2;
  let d = "";
  m.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (!row[x]) continue;
      let w = 1;
      while (row[x + w]) w++;
      d += `M${x + quiet} ${y + quiet}h${w}v1h-${w}z`;
      x += w - 1;
    }
  });
  const a11y = label ? `role="img" aria-label="${label.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)}"` : `aria-hidden="true"`;
  return `<svg class="qr" width="${size}" height="${size}" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges" ${a11y}><rect width="${dim}" height="${dim}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
