import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { encode, Decoder, MAX_OUTBOUND } from "../src/framing.js";

test("encode writes a native-endian length prefix", () => {
  const buf = encode({ a: "ü" });
  const len = os.endianness() === "LE" ? buf.readUInt32LE(0) : buf.readUInt32BE(0);
  assert.equal(len, buf.length - 4);
  assert.equal(buf.subarray(4).toString(), '{"a":"ü"}');
});

test("decoder handles frames split across and merged within chunks", () => {
  const a = encode({ id: "1", type: "ping" });
  const b = encode({ id: "2", type: "list" });
  const all = Buffer.concat([a, b]);
  const d = new Decoder();
  const got = [];
  for (let i = 0; i < all.length; i += 3) got.push(...d.push(all.subarray(i, i + 3)));
  assert.deepEqual(got.map((f) => f.message.id), ["1", "2"]);
  assert.equal(d.pending, 0);

  const d2 = new Decoder();
  assert.deepEqual(d2.push(all).map((f) => f.message.type), ["ping", "list"]);
});

test("decoder reports bad JSON without losing sync", () => {
  const body = Buffer.from("{nope");
  const h = Buffer.alloc(4);
  os.endianness() === "LE" ? h.writeUInt32LE(body.length) : h.writeUInt32BE(body.length);
  const frames = new Decoder().push(Buffer.concat([h, body, encode({ id: "x" })]));
  assert.ok(frames[0].error);
  assert.equal(frames[1].message.id, "x");
});

test("oversized frames are rejected", () => {
  const h = Buffer.alloc(4);
  os.endianness() === "LE" ? h.writeUInt32LE(50_000_000) : h.writeUInt32BE(50_000_000);
  assert.throws(() => new Decoder().push(h), RangeError);
  assert.throws(() => encode({ s: "x".repeat(MAX_OUTBOUND) }), RangeError);
});
