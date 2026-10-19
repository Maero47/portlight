#!/usr/bin/env node
// Portlight native messaging host. Chrome starts it, writes framed requests to stdin
// and reads framed responses from stdout. stdout carries protocol bytes only.
import { Decoder, encode } from "./framing.js";
import { createHandler } from "./handler.js";

// Anything logged by accident must not corrupt the stream.
console.log = console.info = console.debug = console.error;

const handle = createHandler();
const decoder = new Decoder();
const inflight = new Set();

function send(response) {
  let frame;
  try {
    frame = encode(response);
  } catch (err) {
    frame = encode({ id: response.id ?? "", ok: false, error: { code: "internal", message: String(err.message) } });
  }
  process.stdout.write(frame);
}

process.stdin.on("data", (chunk) => {
  let frames;
  try {
    frames = decoder.push(chunk);
  } catch (err) {
    // Broken framing cannot be recovered; tell the caller once and quit.
    send({ id: "", ok: false, error: { code: "bad_request", message: String(err.message) } });
    process.exitCode = 1;
    process.stdin.destroy();
    return;
  }
  for (const f of frames) {
    if (f.error) {
      send({ id: "", ok: false, error: { code: "bad_request", message: `invalid JSON: ${f.error.message}` } });
      continue;
    }
    const p = handle(f.message).then(send);
    inflight.add(p);
    p.finally(() => inflight.delete(p));
  }
});

// Share-link tunnels are our children: they never outlive the host.
// Every exit path ends here: SIGKILL whatever is left, synchronously — no timer survives exit.
process.on("exit", () => handle.close({ force: true }));
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(sig, () => {
    handle.close({ force: true });
    process.exit(128);
  });
}

// Chrome closes stdin when the port disconnects; finish outstanding work, then exit.
process.stdin.on("end", async () => {
  handle.close(); // a tunnel still waiting for its URL fails fast instead of holding the host open
  await Promise.allSettled([...inflight]);
  process.stdout.end(() => process.exit());
});
process.stdin.on("close", () => {
  if (inflight.size === 0) {
    handle.close();
    process.stdout.end(() => process.exit());
  }
});
