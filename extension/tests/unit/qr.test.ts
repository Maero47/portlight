import { describe, expect, test } from "vitest";
import jsQR from "jsqr";
import { encodeQr, qrSvg, type Ecc } from "../../src/lib/qr.ts";

/** Rasterise a module matrix (with a quiet zone) and decode it with an independent decoder. */
function decode(m: boolean[][], scale = 4): string | null {
  const quiet = 4;
  const dim = (m.length + quiet * 2) * scale;
  const px = new Uint8ClampedArray(dim * dim * 4).fill(255);
  m.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (!dark) return;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const i = (((y + quiet) * scale + dy) * dim + (x + quiet) * scale + dx) * 4;
          px[i] = px[i + 1] = px[i + 2] = 0;
        }
      }
    }),
  );
  return jsQR(px, dim, dim, { inversionAttempts: "dontInvert" })?.data ?? null;
}

describe("QR encoder", () => {
  test("phone URLs round-trip through a real decoder", () => {
    for (const url of ["http://192.168.1.23:5173", "http://10.0.0.5:3000/", "http://[2a02:1810::42]:8080", "http://studio.local:6006"]) {
      expect(decode(encodeQr(url))).toBe(url);
    }
  });

  test("version 1 is 21×21; longer text picks a larger version", () => {
    expect(encodeQr("http://a.b:1").length).toBe(21);
    expect(encodeQr("https://seasonal-deck-organisms-sf.trycloudflare.com").length).toBeGreaterThan(21);
  });

  // Lengths that land on many versions (and both char-count widths) for every ECC level,
  // so a wrong entry in the block tables would show up as a decode failure.
  for (const ecc of ["L", "M", "Q", "H"] as Ecc[]) {
    test(`ECC ${ecc}: versions 1-25 decode`, () => {
      const seen = new Set<number>();
      for (let len = 1; len <= 700; len += len < 60 ? 7 : 37) {
        const text = Array.from({ length: len }, (_, i) => "abcdefghijklmnopqrstuvwxyz0123456789:/."[i % 39]).join("");
        let m: boolean[][];
        try {
          m = encodeQr(text, ecc);
        } catch {
          break;
        }
        seen.add((m.length - 17) / 4);
        expect(decode(m, 3), `${ecc} len ${len} v${(m.length - 17) / 4}`).toBe(text);
      }
      expect(seen.size).toBeGreaterThan(8);
    });
  }

  test("UTF-8 text", () => {
    expect(decode(encodeQr("http://café.local:3000/ü"))).toBe("http://café.local:3000/ü");
  });

  test("SVG: quiet zone, crisp edges, escaped label", () => {
    const svg = qrSvg("http://192.168.1.23:5173", { size: 160, label: `Open "x" <on phone>` });
    expect(svg).toContain('viewBox="0 0 33 33"'); // version 2 (25) + 2×4 quiet zone
    expect(svg).toContain('shape-rendering="crispEdges"');
    expect(svg).toContain('aria-label="Open &#34;x&#34; &#60;on phone&#62;"');
    expect(svg).not.toContain("<on");
  });
});
