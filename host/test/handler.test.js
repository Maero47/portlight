import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandler, sameUser } from "../src/handler.js";

const L = (o) => ({ address: "127.0.0.1", family: "IPv4", process: "node", command: "node x", cwd: "/p", user: "me", startedAt: null, ...o });

function setup(listeners, extra = {}) {
  const calls = { scan: 0, signal: [], probe: [], launch: [] };
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
    isMine: async (l) => ({ mine: l.user === "me", owner: l.user }),
    containers: async () => [],
    processPairs: async () => [],
    isDirectory: async (p) => p.startsWith("/"),
    launch: async (file, args) => {
      calls.launch.push([file, ...args]);
    },
    editorCommand: (id, dir) => (id === "zed" ? null : { file: `/bin/${id}`, args: [dir] }),
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
  assert.deepEqual(await handle({ id: "k", type: "kill", pid: 10 }), { id: "k", ok: true, type: "kill", pid: 10, killed: [10] });
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

test("sameUser accepts Windows DOMAIN\\user for the bare username", () => {
  assert.equal(sameUser("DESKTOP\\Me", "me"), true);
  assert.equal(sameUser("me", "me"), true);
  assert.equal(sameUser("DESKTOP\\other", "me"), false);
  assert.equal(sameUser(null, "me"), false);
});

test("kill refuses every pid in the protected chain (host, launcher, browser)", async () => {
  const { handle, calls } = setup([L({ port: 9222, pid: 500 }), L({ port: 3000, pid: 10 })], {
    deps: { protectedPids: async () => new Set([100, 200, 500]) },
  });
  const r = await handle({ id: "p", type: "kill", pid: 500 });
  assert.equal(r.error.code, "not_permitted");
  assert.equal((await handle({ id: "p2", type: "kill", pid: 10 })).ok, true);
  assert.deepEqual(calls.signal, [[10, "SIGTERM"]]);
});

test("malformed requests get bad_request; scan failures get internal", async () => {
  const { handle } = setup([]);
  assert.deepEqual(await handle(null), { id: "", ok: false, error: { code: "bad_request", message: "request must be a JSON object" } });
  assert.equal((await handle({ type: "ping" })).error.code, "bad_request");
  assert.equal((await handle({ id: "x", type: "toString" })).error.code, "bad_request");
  const boom = createHandler({ scan: async () => { throw new Error("lsof exploded"); } });
  assert.deepEqual(await boom({ id: "b", type: "list" }), { id: "b", ok: false, error: { code: "internal", message: "lsof exploded" } });
});

test("kill with tree also signals descendants, skipping protected and other users' pids", async () => {
  // 10 (listener) -> 11 -> 12 ; 10 -> 13 (root-owned) ; 10 -> 1 (protected) ; 99 unrelated
  const pairs = [[10, 5], [11, 10], [12, 11], [13, 10], [1, 10], [99, 5]];
  const { handle, calls } = setup([L({ port: 3000, pid: 10 })], {
    deps: {
      processPairs: async () => pairs,
      isMine: async (l) => ({ mine: l.pid !== 13 && (l.user ?? "me") === "me", owner: l.pid === 13 ? "root" : "me" }),
    },
  });
  const r = await handle({ id: "t", type: "kill", pid: 10, tree: true });
  assert.deepEqual(r, { id: "t", ok: true, type: "kill", pid: 10, killed: [10, 11, 12] });
  assert.deepEqual(calls.signal, [[10, "SIGTERM"], [11, "SIGTERM"], [12, "SIGTERM"]], "parent first, then children");

  const n = await handle({ id: "t2", type: "kill", pid: 10, signal: "KILL" });
  assert.deepEqual(n.killed, [10], "no tree unless asked");
  assert.equal((await handle({ id: "t3", type: "kill", pid: 10, tree: "yes" })).error.code, "bad_request");
});

test("kill with tree: a child that already exited is skipped, not an error", async () => {
  const signalled = [];
  const { handle } = setup([L({ port: 3000, pid: 10 })], {
    deps: {
      processPairs: async () => [[11, 10], [12, 10]],
      isMine: async () => ({ mine: true }),
      signal: (pid) => {
        if (pid === 11) throw Object.assign(new Error("gone"), { code: "ESRCH" });
        signalled.push(pid);
      },
    },
  });
  const r = await handle({ id: "x", type: "kill", pid: 10, tree: true });
  assert.deepEqual(r.killed, [10, 12]);
  assert.deepEqual(signalled, [10, 12]);
});

test("kill refuses container engine forwarders (it would stop every container)", async () => {
  const published = [{ hostIp: "0.0.0.0", hostPort: 5433, container: { id: "abc", name: "shop-postgres-1", image: "postgres:16", project: "shop", containerPort: 5432 } }];
  const { handle, calls } = setup([L({ port: 5433, pid: 40, process: "com.docker.backend" })], { deps: { containers: async () => published } });
  const r = await handle({ id: "d", type: "kill", pid: 40 });
  assert.equal(r.error.code, "not_permitted");
  assert.match(r.error.message, /forwards ports for containers/);
  assert.deepEqual(calls.signal, []);
});

test("list and check carry container info from the engine", async () => {
  const published = [{ hostIp: "0.0.0.0", hostPort: 5433, container: { id: "abc", name: "shop-postgres-1", image: "postgres:16", project: "shop", containerPort: 5432 } }];
  const { handle } = setup([L({ port: 5433, pid: 40, process: "OrbStack Helper" }), L({ port: 3000, pid: 10 })], {
    deps: { containers: async () => published },
  });
  const r = await handle({ id: "l", type: "list" });
  assert.equal(r.listeners.find((l) => l.port === 5433).container.name, "shop-postgres-1");
  assert.equal(r.listeners.find((l) => l.port === 3000).container, null);
  const c = await handle({ id: "c", type: "check", ports: [5433] });
  assert.equal(c.results[0].listener.container.project, "shop");
});

test("a failing container engine never breaks list", async () => {
  const { handle } = setup([L({ port: 3000, pid: 10 })], { deps: { containers: async () => { throw new Error("docker hung"); } } });
  const r = await handle({ id: "l", type: "list" });
  assert.equal(r.ok, true);
  assert.equal(r.listeners.length, 1);
});

test("reveal opens the cwd of an owned listener; refuses others", async () => {
  const { handle, calls } = setup(
    [L({ port: 3000, pid: 10, cwd: "/Users/me/app" }), L({ port: 80, pid: 20, user: "root" }), L({ port: 81, pid: 30, cwd: null }), L({ port: 82, pid: 31, cwd: "/gone" }), L({ port: 5433, pid: 40, process: "vpnkit", cwd: "/" })],
    { deps: { isDirectory: async (p) => p !== "/gone" } },
  );
  assert.deepEqual(await handle({ id: "r", type: "reveal", pid: 10 }), { id: "r", ok: true, type: "reveal", path: "/Users/me/app" });
  assert.equal(calls.launch.length, 1);
  assert.equal(calls.launch[0].at(-1), "/Users/me/app");
  assert.equal((await handle({ id: "r2", type: "reveal", pid: 20 })).error.code, "not_permitted");
  assert.equal((await handle({ id: "r3", type: "reveal", pid: 99 })).error.code, "not_found");
  assert.equal((await handle({ id: "r4", type: "reveal", pid: 30 })).error.code, "not_found");
  assert.equal((await handle({ id: "r5", type: "reveal", pid: 31 })).error.code, "not_found");
  assert.equal((await handle({ id: "r6", type: "reveal", pid: 40 })).error.code, "not_permitted");
  assert.equal((await handle({ id: "r7", type: "reveal", pid: "10" })).error.code, "bad_request");
  assert.equal(calls.launch.length, 1, "nothing else launched");
});

test("reveal reports a missing file manager as not_found", async () => {
  const { handle } = setup([L({ port: 3000, pid: 10 })], {
    deps: { launch: async () => { const e = new Error("spawn xdg-open ENOENT"); e.code = "ENOENT"; throw e; } },
  });
  const r = await handle({ id: "r", type: "reveal", pid: 10 });
  assert.equal(r.error.code, "not_found");
});

test("openEditor: whitelisted ids only, argv without a shell, clear not_found", async () => {
  const { handle, calls } = setup([L({ port: 3000, pid: 10, cwd: "/Users/me/app" }), L({ port: 80, pid: 20, user: "root" })]);
  assert.deepEqual(await handle({ id: "e", type: "openEditor", pid: 10, editor: "vscode" }), { id: "e", ok: true, type: "openEditor", path: "/Users/me/app" });
  assert.deepEqual(calls.launch, [["/bin/vscode", "/Users/me/app"]]);
  const missing = await handle({ id: "e2", type: "openEditor", pid: 10, editor: "zed" });
  assert.equal(missing.error.code, "not_found");
  assert.match(missing.error.message, /Zed is not installed/);
  for (const editor of [undefined, "vim", "toString", "code && rm -rf ~", 5]) {
    assert.equal((await handle({ id: "e3", type: "openEditor", pid: 10, editor })).error.code, "bad_request", String(editor));
  }
  assert.equal((await handle({ id: "e4", type: "openEditor", pid: 20, editor: "vscode" })).error.code, "not_permitted");
  assert.equal(calls.launch.length, 1);
});

test("Windows tree kill never signals a stale-parent orphan", async () => {
  const pairs = [[3000, 1200, 1760000100000], [3010, 3000, 1760000100500], [2100, 3000, 1759990000000]];
  const { handle, calls } = setup([L({ port: 3000, pid: 3000 })], {
    deps: { processPairs: async () => pairs, isMine: async () => ({ mine: true }) },
  });
  const r = await handle({ id: "w", type: "kill", pid: 3000, tree: true });
  assert.deepEqual(r.killed, [3000, 3010]);
  assert.ok(!calls.signal.some(([p]) => p === 2100));
});

// ---------- netinfo, settings shortcuts, share-link tunnels ----------

test("netinfo returns the hostname and LAN addresses", async () => {
  const addresses = [{ name: "en0", address: "192.168.1.23", family: "IPv4", virtual: false }];
  const { handle } = setup([], { deps: { netinfo: async () => ({ hostname: "studio.local", addresses }) } });
  assert.deepEqual(await handle({ id: "n", type: "netinfo" }), { id: "n", ok: true, type: "netinfo", hostname: "studio.local", addresses });
});

test("openSettings launches a whitelisted pane on macOS only", async () => {
  const mac = setup([], { deps: { platform: "darwin", settingsCommand: (pane) => ({ file: "/usr/bin/open", args: [`x-apple.systempreferences:${pane}`] }) } });
  assert.deepEqual(await mac.handle({ id: "s", type: "openSettings", pane: "airdrop-handoff" }), { id: "s", ok: true, type: "openSettings", pane: "airdrop-handoff" });
  assert.deepEqual(mac.calls.launch, [["/usr/bin/open", "x-apple.systempreferences:airdrop-handoff"]]);
  for (const pane of ["x-apple.systempreferences:com.apple.Users", "__proto__", 3, undefined]) {
    const r = await mac.handle({ id: "b", type: "openSettings", pane });
    assert.equal(r.error?.code, "bad_request", String(pane));
  }
  const linux = setup([], { deps: { platform: "linux", settingsCommand: () => null } });
  assert.equal((await linux.handle({ id: "l", type: "openSettings", pane: "sharing" })).error.code, "not_found");
  assert.deepEqual(linux.calls.launch, []);
});

/** A tunnel manager double that records what the handler asked for. */
function fakeTunnels() {
  const started = [];
  const stopped = [];
  return {
    started,
    stopped,
    providers: () => ({ cloudflared: true, ngrok: false }),
    list: () => started.map(([port]) => ({ port, provider: "cloudflared", url: `https://p${port}.trycloudflare.com`, startedAt: "t" })),
    start: async (port, target, provider) => {
      const host = await target();
      started.push([port, host, provider]);
      if (port === 4444) throw { code: "internal", message: "429 Too Many Requests" };
      return { port, provider: "cloudflared", url: `https://p${port}.trycloudflare.com`, startedAt: "t" };
    },
    stop: (port) => (stopped.push(port), true),
    stopAll: () => stopped.push("all"),
  };
}

test("tunnelStart shares your own listening port through the forwarded loopback address", async () => {
  const tunnels = fakeTunnels();
  const { handle } = setup(
    [
      L({ port: 5173, pid: 10, address: "::1", family: "IPv6" }),
      L({ port: 3000, pid: 11, address: "*" }),
      L({ port: 3000, pid: 11, address: "::", family: "IPv6" }),
      L({ port: 4444, pid: 12 }),
    ],
    { deps: { tunnels } },
  );
  const r = await handle({ id: "t", type: "tunnelStart", port: 5173 });
  assert.deepEqual(r, { id: "t", ok: true, type: "tunnelStart", tunnel: { port: 5173, provider: "cloudflared", url: "https://p5173.trycloudflare.com", startedAt: "t" } });
  await handle({ id: "t2", type: "tunnelStart", port: 3000, provider: "ngrok" });
  assert.deepEqual(tunnels.started, [[5173, "::1", undefined], [3000, "127.0.0.1", "ngrok"]]);
  assert.deepEqual(await handle({ id: "e", type: "tunnelStart", port: 4444 }), {
    id: "e", ok: false, error: { code: "internal", message: "429 Too Many Requests" },
  });
  const st = await handle({ id: "s", type: "tunnelStatus" });
  assert.deepEqual(st.providers, { cloudflared: true, ngrok: false });
  assert.equal(st.tunnels.length, 3);
  assert.deepEqual(await handle({ id: "x", type: "tunnelStop", port: 5173 }), { id: "x", ok: true, type: "tunnelStop", port: 5173, stopped: true });
  handle.close();
  assert.deepEqual(tunnels.stopped, [5173, "all"]);
});

test("tunnelStart refuses bad input, silent ports and other users' servers", async () => {
  const tunnels = fakeTunnels();
  const { handle } = setup(
    [
      L({ port: 6000, pid: 20, user: "root" }),
      L({ port: 6001, pid: null, process: null, user: null }),
      L({ port: 5433, pid: null, process: null, user: null, container: { id: "a", name: "db", image: "postgres" } }),
    ],
    { busyPorts: [7000], deps: { tunnels } },
  );
  const code = async (body) => (await handle({ id: "q", type: "tunnelStart", ...body })).error?.code ?? "ok";
  assert.equal(await code({ port: 0 }), "bad_request");
  assert.equal(await code({ port: "3000" }), "bad_request");
  assert.equal(await code({ port: 3000, provider: "/bin/sh" }), "bad_request");
  assert.equal(await code({ port: 3000 }), "not_found", "nothing listening");
  assert.equal(await code({ port: 7000 }), "not_permitted", "listening but owner invisible");
  assert.equal(await code({ port: 6000 }), "not_permitted", "root's server");
  assert.equal(await code({ port: 6001 }), "not_permitted", "no owner");
  assert.equal(await code({ port: 5433 }), "ok", "a port your container engine publishes");
  assert.deepEqual(tunnels.started.map(([p]) => p), [5433]);
});

test("tunnelStop before any tunnel exists is a no-op", async () => {
  const { handle } = setup([]);
  assert.deepEqual(await handle({ id: "x", type: "tunnelStop", port: 3000 }), { id: "x", ok: true, type: "tunnelStop", port: 3000, stopped: false });
  assert.equal((await handle({ id: "y", type: "tunnelStop", port: -1 })).error.code, "bad_request");
});

test("tunnelStop that arrives during tunnelStart's port scan cancels it before anything is spawned", async () => {
  const { createTunnelManager } = await import("../src/tunnel.js");
  const spawned = [];
  const tunnels = createTunnelManager({ find: (n) => `/bin/${n}`, spawn: (f, a) => (spawned.push([f, ...a]), { on() {}, once() {} }) });
  let releaseScan;
  const scanned = new Promise((r) => (releaseScan = r));
  const { handle } = setup([], {
    deps: {
      tunnels,
      scan: async () => (await scanned, [L({ port: 5173, pid: 10 })]),
    },
  });
  const start = handle({ id: "s", type: "tunnelStart", port: 5173 });
  const stop = await handle({ id: "x", type: "tunnelStop", port: 5173 });
  assert.equal(stop.stopped, true, "the starting port is already registered");
  releaseScan();
  assert.deepEqual(await start, { id: "s", ok: false, error: { code: "cancelled", message: "the share link for port 5173 was cancelled" } });
  assert.deepEqual(spawned, []);
  assert.deepEqual((await handle({ id: "t", type: "tunnelStatus" })).tunnels, []);
});
