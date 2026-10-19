// The real host process starts a fake `cloudflared` found on PATH, reads its URL, stops it on
// request and when the host's stdin closes (the browser went away).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encode, Decoder } from "../src/framing.js";

const MAIN = fileURLToPath(new URL("../src/main.js", import.meta.url));
const supported = ["darwin", "linux"].includes(process.platform);

let dir;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "portlight-tunnel-"));
  // Prints a quick-tunnel banner like the real one, records its argv and pid, runs until signalled.
  fs.writeFileSync(
    path.join(dir, "cloudflared"),
    `#!${process.execPath}
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(path.join(dir, "argv.json"))}, JSON.stringify({ argv: process.argv.slice(2), pid: process.pid }));
process.stderr.write("INF Requesting new quick Tunnel on trycloudflare.com...\\n");
// Real quick tunnels take seconds to print their URL; PORTLIGHT_FAKE_CF_DELAY_MS sets how long.
setTimeout(() => process.stderr.write("INF |  https://fake-quick-tunnel-test.trycloudflare.com  |\\n"), Number(process.env.PORTLIGHT_FAKE_CF_DELAY_MS ?? 150));
setInterval(() => {}, 1000);
`,
    { mode: 0o755 },
  );
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

function startHost(env) {
  const child = spawn(process.execPath, [MAIN], { stdio: ["pipe", "pipe", "inherit"], env });
  const dec = new Decoder();
  const waiting = new Map();
  child.stdout.on("data", (c) => {
    for (const f of dec.push(c)) waiting.get(f.message.id)?.(f.message);
  });
  let n = 0;
  const request = (body) =>
    new Promise((resolve) => {
      const id = `t${++n}`;
      waiting.set(id, resolve);
      child.stdin.write(encode({ id, ...body }));
    });
  return { child, request };
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

const listen = () =>
  new Promise((resolve) => {
    const s = net.createServer((sock) => sock.destroy());
    s.listen({ host: "127.0.0.1", port: 0 }, () => resolve(s));
  });

test("tunnel lifecycle with a fake cloudflared", { skip: !supported, timeout: 30_000 }, async () => {
  const env = { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` };
  const server = await listen();
  const { port } = server.address();
  const host = startHost(env);
  try {
    const status = await host.request({ type: "tunnelStatus" });
    assert.equal(status.ok, true);
    assert.equal(status.providers.cloudflared, true);
    assert.deepEqual(status.tunnels, []);

    const started = await host.request({ type: "tunnelStart", port });
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.equal(started.tunnel.url, "https://fake-quick-tunnel-test.trycloudflare.com");
    assert.equal(started.tunnel.provider, "cloudflared");
    const { argv, pid } = JSON.parse(fs.readFileSync(path.join(dir, "argv.json"), "utf8"));
    assert.deepEqual(argv, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`, "--http-host-header", `127.0.0.1:${port}`]);
    assert.ok(alive(pid));
    assert.equal((await host.request({ type: "tunnelStatus" })).tunnels.length, 1);

    const stopped = await host.request({ type: "tunnelStop", port });
    assert.deepEqual([stopped.ok, stopped.stopped], [true, true]);
    assert.ok(await until(() => !alive(pid)), "stopped on request");

    // Started again, then the browser goes away: the host takes the tunnel down with it.
    await host.request({ type: "tunnelStart", port });
    const again = JSON.parse(fs.readFileSync(path.join(dir, "argv.json"), "utf8")).pid;
    assert.notEqual(again, pid);
    assert.ok(alive(again));
    host.child.stdin.end();
    assert.ok(await until(() => host.child.exitCode !== null), "host exits");
    assert.ok(await until(() => !alive(again)), "tunnel stopped with the host");
  } finally {
    host.child.kill();
    await new Promise((r) => server.close(r));
  }
});

test("status during a slow start lists the tunnel as starting, and the link still comes up", { skip: !supported, timeout: 30_000 }, async () => {
  const env = { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`, PORTLIGHT_FAKE_CF_DELAY_MS: "2500" };
  const server = await listen();
  const { port } = server.address();
  const host = startHost(env);
  try {
    const pending = host.request({ type: "tunnelStart", port });
    await new Promise((r) => setTimeout(r, 600));
    const mid = await host.request({ type: "tunnelStatus" });
    assert.deepEqual(
      mid.tunnels.map((t) => [t.port, t.state, t.url]),
      [[port, "starting", null]],
    );
    const started = await pending;
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.equal(started.tunnel.state, "running");
    const after = await host.request({ type: "tunnelStatus" });
    assert.deepEqual(after.tunnels.map((t) => t.state), ["running"]);
    await host.request({ type: "tunnelStop", port });
  } finally {
    host.child.stdin.end();
    await new Promise((r) => server.close(r));
  }
});

test("tunnelStart refuses a port nobody listens on, without starting anything", { skip: !supported }, async () => {
  const env = { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` };
  fs.rmSync(path.join(dir, "argv.json"), { force: true });
  const server = await listen();
  const { port } = server.address();
  await new Promise((r) => server.close(r));
  const host = startHost(env);
  try {
    const r = await host.request({ type: "tunnelStart", port });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "not_found");
    assert.equal(fs.existsSync(path.join(dir, "argv.json")), false);
  } finally {
    host.child.stdin.end();
  }
});
