#!/usr/bin/env node
// Debug helper for the native messaging framing.
//   node scripts/frame.js '{"id":"1","type":"list"}' | node src/main.js | node scripts/frame.js --decode
// Encode: each argument (a JSON string) becomes one frame on stdout.
// Decode: reads frames from stdin and prints each message as pretty JSON.
import { Decoder, encode } from "../src/framing.js";

const args = process.argv.slice(2);
if (args[0] === "--decode") {
  const dec = new Decoder({ maxLength: 64 * 1024 * 1024 });
  process.stdin.on("data", (c) => {
    for (const f of dec.push(c)) console.log(f.error ? `<invalid JSON: ${f.error.message}>` : JSON.stringify(f.message, null, 2));
  });
  process.stdin.on("end", () => {
    if (dec.pending) console.error(`<${dec.pending} trailing bytes>`);
  });
} else if (args.length) {
  for (const a of args) process.stdout.write(encode(JSON.parse(a)));
} else {
  console.error("usage: frame.js '<json>' [...]  |  frame.js --decode");
  process.exit(2);
}
