import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { candidatePorts, probePort, CHROME_UNSAFE_PORTS } from "../src/ports.js";

const listen = (host, port = 0) =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen({ host, port }, () => resolve(s));
  });
const close = (s) => new Promise((r) => s.close(r));

test("candidatePorts orders by distance and stays in range", () => {
  const take = (gen, n) => Array.from({ length: n }, () => gen.next().value);
  assert.deepEqual(take(candidatePorts(8080), 5), [8080, 8081, 8079, 8082, 8078]);
  assert.deepEqual(take(candidatePorts(1024), 3), [1024, 1025, 1026]);
  assert.deepEqual(take(candidatePorts(65535), 3), [65535, 65534, 65533]);
  assert.ok(take(candidatePorts(6666), 20).every((p) => !CHROME_UNSAFE_PORTS.has(p)));
  assert.deepEqual(take(candidatePorts(3000, new Set([3000, 3001])), 2), [2999, 3002]);
});

test("probePort sees listeners on loopback, wildcard and IPv6, and frees after close", async () => {
  for (const host of ["127.0.0.1", "0.0.0.0", "::1", "::"]) {
    let s;
    try {
      s = await listen(host);
    } catch {
      continue; // no IPv6 here
    }
    const { port } = s.address();
    assert.equal(await probePort(port), "busy", `listener on ${host}`);
    await close(s);
    assert.equal(await probePort(port), "free", `after closing ${host}`);
  }
});
