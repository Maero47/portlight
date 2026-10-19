// Runs the real host process against real sockets.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { encode, Decoder } from "../src/framing.js";

const MAIN = fileURLToPath(new URL("../src/main.js", import.meta.url));
const supported = ["darwin", "linux"].includes(process.platform);

function startHost() {
  const child = spawn(process.execPath, [MAIN], { stdio: ["pipe", "pipe", "inherit"] });
  const dec = new Decoder({ maxLength: 64 * 1024 * 1024 });
  const waiting = new Map();
  child.stdout.on("data", (c) => {
    for (const f of dec.push(c)) {
      const w = waiting.get(f.message.id);
      if (w) {
        waiting.delete(f.message.id);
        w(f.message);
      }
    }
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

const listen = (host = "127.0.0.1") =>
  new Promise((resolve) => {
    const s = net.createServer((sock) => sock.destroy());
    s.listen({ host, port: 0 }, () => resolve(s));
  });

async function freePort() {
  const s = await listen();
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

function waitExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", () => resolve());
  });
}

let host;
let server;
before(async () => {
  host = startHost();
  server = await listen();
});
after(async () => {
  host.child.stdin.end();
  await waitExit(host.child);
  await new Promise((r) => server.close(r));
});

test("list finds a live listener with pid, process, cwd and start time", { skip: !supported }, async () => {
  const { port } = server.address();
  const t0 = Date.now();
  const res = await host.request({ type: "list" });
  const elapsed = Date.now() - t0;
  assert.equal(res.ok, true);
  const mine = res.listeners.find((l) => l.port === port);
  assert.ok(mine, `port ${port} missing from list`);
  assert.equal(mine.pid, process.pid);
  assert.equal(mine.address, "127.0.0.1");
  assert.equal(mine.family, "IPv4");
  assert.match(mine.process, /^node/);
  assert.equal(fs.realpathSync(mine.cwd), fs.realpathSync(process.cwd()));
  assert.equal(mine.user, os.userInfo().username);
  assert.ok(mine.command.includes("node"), mine.command);
  const started = Date.parse(mine.startedAt);
  assert.ok(Math.abs(Date.now() - started) < 10 * 60_000, `startedAt ${mine.startedAt}`);
  assert.ok(elapsed < 1000, `list took ${elapsed} ms`);
});

test("check reports the live port busy (with owner) and a closed port free", { skip: !supported }, async () => {
  const { port } = server.address();
  const closed = await freePort();
  const res = await host.request({ type: "check", ports: [port, closed] });
  assert.equal(res.ok, true);
  assert.deepEqual(res.results.map((r) => r.free), [false, true]);
  assert.equal(res.results[0].listener.pid, process.pid);
});

test("suggest returns free ports that can actually be bound", { skip: !supported }, async () => {
  const res = await host.request({ type: "suggest", near: 41000, count: 3 });
  assert.equal(res.ports.length, 3);
  for (const p of res.ports) {
    const s = net.createServer();
    await new Promise((resolve, reject) => s.once("error", reject).listen({ host: "127.0.0.1", port: p }, resolve));
    await new Promise((r) => s.close(r));
  }
});

test("kill terminates a listening child and refuses non-listeners", { skip: !supported }, async () => {
  const child = spawn(process.execPath, ["-e", "require('net').createServer().listen(0,'127.0.0.1',()=>console.log('ready'))"], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((r) => child.stdout.once("data", r));
  const idle = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], { stdio: "ignore" });
  try {
    const refused = await host.request({ type: "kill", pid: idle.pid });
    assert.equal(refused.ok, false);
    assert.equal(refused.error.code, "not_found");

    const res = await host.request({ type: "kill", pid: child.pid });
    assert.deepEqual(res, { id: res.id, ok: true, type: "kill", pid: child.pid });
    await waitExit(child);
    assert.equal(child.signalCode, "SIGTERM");
  } finally {
    child.kill("SIGKILL");
    idle.kill("SIGKILL");
  }
});

test("host survives bad JSON and answers the next request", async () => {
  const body = Buffer.from("not json");
  const h = Buffer.alloc(4);
  os.endianness() === "LE" ? h.writeUInt32LE(body.length) : h.writeUInt32BE(body.length);
  host.child.stdin.write(Buffer.concat([h, body]));
  const res = await host.request({ type: "ping" });
  assert.equal(res.type, "pong");
});
