import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "../src/handler.js";

const L = (o) => ({ address: "127.0.0.1", family: "IPv4", process: "node", command: "node x", cwd: "/p", user: "me", startedAt: null, ...o });

function setup(listeners, extra = {}) {
  const calls = { scan: 0, signal: [], probe: [] };
  const handle = createHandler({
    platform: "testos",
    user: "me",
    protectedPids: new Set([1]),
    scan: async () => {
      calls.scan++;
      return listeners;
    },
    probe: async (p) => {
      calls.probe.push(p);
      return extra.busyPorts?.includes(p) ? "busy" : "free";
    },
    signal: (pid, sig) => {
      if (extra.signalError) {
        const e = new Error("x");
        e.code = extra.signalError;
        throw e;
      }
      calls.signal.push([pid, sig]);
    },
    ownerOf: async (l) => l.user,
    ...extra.deps,
  });
  return { handle, calls };
}

test("ping", async () => {
  const { handle } = setup([]);
  const r = await handle({ id: "a", type: "ping" });
  assert.deepEqual(r, { id: "a", ok: true, type: "pong", version: 1, platform: "testos", hostVersion: r.hostVersion });
  assert.match(r.hostVersion, /^\d+\.\d+\.\d+/);
});

test("list returns listeners and a timestamp; close requests share one scan", async () => {
  const { handle, calls } = setup([L({ port: 3000, pid: 10 })]);
  const [a, b] = await Promise.all([handle({ id: "1", type: "list" }), handle({ id: "2", type: "list" })]);
  assert.equal(a.listeners.length, 1);
  assert.ok(!Number.isNaN(Date.parse(a.scannedAt)));
  assert.equal(b.id, "2");
  assert.equal(calls.scan, 1);
});

test("check uses the scan first and probes only unknown ports", async () => {
  const { handle, calls } = setup([L({ port: 3000, pid: null, process: null }), L({ port: 3000, pid: 10 })], { busyPorts: [5000] });
  const r = await handle({ id: "c", type: "check", ports: [3000, 4000, 5000] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.results.map((x) => [x.port, x.free]), [[3000, false], [4000, true], [5000, false]]);
  assert.equal(r.results[0].listener.pid, 10, "prefers the listener with a known pid");
  assert.equal(r.results[2].listener, undefined);
  assert.deepEqual(calls.probe.sort(), [4000, 5000]);
});

test("check validates input", async () => {
  const { handle } = setup([]);
  for (const ports of [undefined, [], [0], [70000], [1.5], ["80"], new Array(1001).fill(80)]) {
    const r = await handle({ id: "v", type: "check", ports });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "bad_request");
  }
});

test("suggest skips busy, unsafe and well-known ports, nearest first", async () => {
  const { handle } = setup([L({ port: 3000, pid: 10 })], { busyPorts: [3002] });
  const r = await handle({ id: "s", type: "suggest", near: 3000, count: 4 });
  assert.deepEqual(r.ports, [3001, 2999, 2998, 3003]);
  const r2 = await handle({ id: "s2", type: "suggest", near: 6000, count: 2 });
  assert.ok(!r2.ports.includes(6000), "6000 is on Chrome's unsafe list");
  const r3 = await handle({ id: "s3", type: "suggest", near: 5432, count: 1 });
  assert.notEqual(r3.ports[0], 5432);
  const d = await handle({ id: "s4", type: "suggest" });
  assert.equal(d.ports.length, 5);
  assert.equal((await handle({ id: "s5", type: "suggest", count: 0 })).error.code, "bad_request");
  assert.equal((await handle({ id: "s6", type: "suggest", near: 99999 })).error.code, "bad_request");
});

test("kill signals only listeners owned by the current user", async () => {
  const { handle, calls } = setup([L({ port: 3000, pid: 10 }), L({ port: 80, pid: 20, user: "root" }), L({ port: 81, pid: 30, user: null })]);
  assert.deepEqual(await handle({ id: "k", type: "kill", pid: 10 }), { id: "k", ok: true, type: "kill", pid: 10 });
  assert.deepEqual(calls.signal, [[10, "SIGTERM"]]);
  await handle({ id: "k2", type: "kill", pid: 10, signal: "KILL" });
  assert.deepEqual(calls.signal[1], [10, "SIGKILL"]);

  assert.equal((await handle({ id: "k3", type: "kill", pid: 20 })).error.code, "not_permitted");
  assert.equal((await handle({ id: "k4", type: "kill", pid: 30 })).error.code, "not_permitted");
  assert.equal((await handle({ id: "k5", type: "kill", pid: 99 })).error.code, "not_found");
  assert.equal((await handle({ id: "k6", type: "kill", pid: 1 })).error.code, "not_permitted");
  assert.equal((await handle({ id: "k7", type: "kill", pid: -5 })).error.code, "bad_request");
  assert.equal((await handle({ id: "k8", type: "kill", pid: 10, signal: "HUP" })).error.code, "bad_request");
  assert.equal(calls.signal.length, 2);
});

test("kill maps OS errors", async () => {
  const a = setup([L({ port: 3000, pid: 10 })], { signalError: "ESRCH" });
  assert.equal((await a.handle({ id: "e", type: "kill", pid: 10 })).error.code, "not_found");
  const b = setup([L({ port: 3000, pid: 10 })], { signalError: "EPERM" });
  assert.equal((await b.handle({ id: "e", type: "kill", pid: 10 })).error.code, "not_permitted");
});

test("Windows-style DOMAIN\\user owner matches the bare username", async () => {
  const { handle } = setup([L({ port: 3000, pid: 10, user: null })], { deps: { ownerOf: async () => "DESKTOP\\Me" } });
  assert.equal((await handle({ id: "w", type: "kill", pid: 10 })).ok, true);
});

test("malformed requests get bad_request; scan failures get internal", async () => {
  const { handle } = setup([]);
  assert.deepEqual(await handle(null), { id: "", ok: false, error: { code: "bad_request", message: "request must be a JSON object" } });
  assert.equal((await handle({ type: "ping" })).error.code, "bad_request");
  assert.equal((await handle({ id: "x", type: "toString" })).error.code, "bad_request");
  const boom = createHandler({ scan: async () => { throw new Error("lsof exploded"); } });
  assert.deepEqual(await boom({ id: "b", type: "list" }), { id: "b", ok: false, error: { code: "internal", message: "lsof exploded" } });
});
