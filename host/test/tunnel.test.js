import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createTunnelManager, PROVIDERS, PROVIDER_IDS, tunnelError } from "../src/tunnel.js";

/** A ChildProcess look-alike that the test drives by hand. */
function fakeChild() {
  const c = new EventEmitter();
  c.stdout = new PassThrough();
  c.stderr = new PassThrough();
  c.exitCode = null;
  c.signalCode = null;
  c.signals = [];
  c.kill = (sig) => {
    c.signals.push(sig);
    c.signalCode = sig;
    setImmediate(() => c.emit("exit", null, sig));
    return true;
  };
  return c;
}

function setup({ installed = ["cloudflared", "ngrok"], probe = async () => "busy", startTimeoutMs } = {}) {
  const spawned = [];
  const mgr = createTunnelManager({
    find: (name) => (installed.includes(name) ? `/bin/${name}` : null),
    spawn: (file, args) => {
      const child = fakeChild();
      spawned.push({ file, args, child });
      return child;
    },
    probe,
    now: () => new Date("2026-01-02T03:04:05Z"),
    startTimeoutMs,
    watchMs: 60_000,
  });
  return { mgr, spawned };
}

const CF_BANNER = `2026-01-02T03:04:05Z INF Requesting new quick Tunnel on trycloudflare.com...
2026-01-02T03:04:06Z INF +--------------------------------------------------------------------------------------------+
2026-01-02T03:04:06Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
2026-01-02T03:04:06Z INF |  https://seasonal-deck-organisms-sf.trycloudflare.com                                       |
2026-01-02T03:04:06Z INF +--------------------------------------------------------------------------------------------+
`;

test("only cloudflared and ngrok, cloudflared preferred", () => {
  assert.deepEqual(PROVIDER_IDS, ["cloudflared", "ngrok"]);
});

test("argv: fixed flags, numeric target, host header rewritten for dev servers", () => {
  assert.deepEqual(PROVIDERS.cloudflared.args("http://127.0.0.1:5173", "127.0.0.1:5173"), [
    "tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:5173", "--http-host-header", "127.0.0.1:5173",
  ]);
  assert.deepEqual(PROVIDERS.ngrok.args("http://[::1]:3000", "[::1]:3000"), [
    "http", "http://[::1]:3000", "--host-header=rewrite", "--log", "stdout", "--log-format", "logfmt",
  ]);
});

test("URL parsing ignores cloudflared's API host and reads ngrok's logfmt", () => {
  assert.equal(PROVIDERS.cloudflared.url(`failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel"`), null);
  assert.equal(PROVIDERS.cloudflared.url(CF_BANNER), "https://seasonal-deck-organisms-sf.trycloudflare.com");
  assert.equal(
    PROVIDERS.ngrok.url(`t=2026 lvl=info msg="started tunnel" obj=tunnels name=command_line addr=http://127.0.0.1:3000 url=https://ab12-1-2-3-4.ngrok-free.app`),
    "https://ab12-1-2-3-4.ngrok-free.app",
  );
});

test("error lines are turned into something a person can act on", () => {
  assert.match(tunnelError("ngrok", "ERROR:  authentication failed: ... ERR_NGROK_4018"), /ngrok config add-authtoken/);
  assert.equal(
    tunnelError("cloudflared", "2026 INF Requesting\n2026 ERR failed to request quick Tunnel: dial tcp: no such host\n"),
    "failed to request quick Tunnel: dial tcp: no such host",
  );
  assert.equal(tunnelError("cloudflared", ""), "cloudflared stopped before it printed a public URL.");
});

test("start resolves with the public URL; a second start for the port reuses it", async () => {
  const { mgr, spawned } = setup();
  const p = mgr.start(5173, "127.0.0.1");
  assert.deepEqual(mgr.list(), [], "not listed until it has a URL");
  spawned[0].child.stderr.write(CF_BANNER);
  const t = await p;
  assert.deepEqual(t, { port: 5173, provider: "cloudflared", url: "https://seasonal-deck-organisms-sf.trycloudflare.com", startedAt: "2026-01-02T03:04:05.000Z" });
  assert.equal(spawned[0].file, "/bin/cloudflared");
  assert.deepEqual(await mgr.start(5173, "127.0.0.1"), t);
  assert.equal(spawned.length, 1);
  assert.deepEqual(mgr.list(), [t]);
});

test("IPv6 targets are bracketed", async () => {
  const { mgr, spawned } = setup({ installed: ["ngrok"] });
  const p = mgr.start(3000, "::1");
  assert.equal(spawned[0].args[1], "http://[::1]:3000");
  spawned[0].child.stdout.write("t=1 lvl=info msg=\"started tunnel\" url=https://x.ngrok-free.app\n");
  assert.equal((await p).provider, "ngrok");
});

test("stop terminates the process and forgets the tunnel", async () => {
  const { mgr, spawned } = setup();
  const p = mgr.start(3000, "127.0.0.1");
  spawned[0].child.stderr.write(CF_BANNER);
  await p;
  assert.equal(mgr.stop(3000), true);
  assert.deepEqual(spawned[0].child.signals, ["SIGTERM"]);
  assert.deepEqual(mgr.list(), []);
  assert.equal(mgr.stop(3000), false);
});

test("stopAll stops every tunnel (host exit)", async () => {
  const { mgr, spawned } = setup();
  const a = mgr.start(3000, "127.0.0.1");
  const b = mgr.start(4000, "127.0.0.1");
  spawned[0].child.stderr.write(CF_BANNER);
  spawned[1].child.stderr.write(CF_BANNER);
  await Promise.all([a, b]);
  mgr.stopAll();
  assert.deepEqual(spawned.map((s) => s.child.signals), [["SIGTERM"], ["SIGTERM"]]);
  assert.deepEqual(mgr.list(), []);
});

test("a tunnel that exits before printing a URL rejects with its error", async () => {
  const { mgr, spawned } = setup();
  const p = mgr.start(3000, "127.0.0.1");
  spawned[0].child.stderr.write("2026 ERR failed to request quick Tunnel: 429 Too Many Requests\n");
  spawned[0].child.exitCode = 1;
  spawned[0].child.emit("exit", 1, null);
  await assert.rejects(p, { code: "internal", message: "failed to request quick Tunnel: 429 Too Many Requests" });
  assert.deepEqual(mgr.list(), []);
});

test("a tunnel that never prints a URL times out and is killed", async () => {
  const { mgr, spawned } = setup({ startTimeoutMs: 30 });
  await assert.rejects(mgr.start(3000, "127.0.0.1"), { code: "internal", message: /did not print a public URL/ });
  assert.deepEqual(spawned[0].child.signals, ["SIGTERM"]);
});

test("nothing installed: not_found, nothing spawned", async () => {
  const { mgr, spawned } = setup({ installed: [] });
  assert.deepEqual(mgr.providers(), { cloudflared: false, ngrok: false });
  await assert.rejects(mgr.start(3000, "127.0.0.1"), { code: "not_found", message: "neither cloudflared nor ngrok is installed" });
  await assert.rejects(setup({ installed: ["ngrok"] }).mgr.start(3000, "127.0.0.1", "cloudflared"), { code: "not_found" });
  assert.equal(spawned.length, 0);
});

test("spawn errors (binary vanished) reject as not_found", async () => {
  const { mgr, spawned } = setup();
  const p = mgr.start(3000, "127.0.0.1");
  spawned[0].child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
  await assert.rejects(p, { code: "not_found" });
});

test("at most four tunnels at a time", async () => {
  const { mgr } = setup();
  for (const port of [3001, 3002, 3003, 3004]) void mgr.start(port, "127.0.0.1").catch(() => {});
  await assert.rejects(mgr.start(3005, "127.0.0.1"), { code: "not_permitted" });
  mgr.stopAll();
});

test("the watchdog closes a tunnel after its port stops listening twice in a row", async () => {
  let state = "busy";
  const { mgr, spawned } = setup({ probe: async () => state });
  const p = mgr.start(3000, "127.0.0.1");
  spawned[0].child.stderr.write(CF_BANNER);
  await p;
  await mgr.watch();
  assert.equal(mgr.list().length, 1);
  state = "free";
  await mgr.watch();
  assert.equal(mgr.list().length, 1, "one miss is a restart, not a stop");
  state = "busy";
  await mgr.watch();
  state = "free";
  await mgr.watch();
  await mgr.watch();
  assert.deepEqual(mgr.list(), []);
  assert.deepEqual(spawned[0].child.signals, ["SIGTERM"]);
});
