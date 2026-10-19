// Public share links through cloudflared (quick tunnels, no account) or ngrok.
// Only these two binaries, found by exact name in fixed directories, started with
// spawn + an argument array (never a shell). Every tunnel is a child of the host:
// it stops on request, when its port stops listening, or when the host exits.
import { spawn as nodeSpawn } from "node:child_process";
import { findBinary } from "./containers.js";

const START_TIMEOUT_MS = 25_000; // cloudflared usually prints its URL within 3-8 s
const STOP_GRACE_MS = 2_000;
const WATCH_MS = 5_000;
const MAX_TUNNELS = 4;
const MAX_LOG = 16 * 1024;

/**
 * The binaries Portlight may start, in order of preference. `args` gets a target such as
 * "http://127.0.0.1:5173" and the bare "host:port". The Host header is rewritten to the
 * local address, because dev servers (Vite, Django) refuse unknown hosts.
 */
export const PROVIDERS = Object.freeze({
  cloudflared: {
    label: "cloudflared",
    // --grace-period: cloudflared otherwise waits up to 30 s for open requests after SIGTERM.
    args: (target, hostPort) => ["tunnel", "--no-autoupdate", "--grace-period", "1s", "--url", target, "--http-host-header", hostPort],
    url: (text) => {
      for (const m of text.matchAll(/https:\/\/([a-z0-9-]+)\.trycloudflare\.com\b/g)) {
        if (m[1] !== "api") return m[0];
      }
      return null;
    },
  },
  ngrok: {
    label: "ngrok",
    args: (target) => ["http", target, "--host-header=rewrite", "--log", "stdout", "--log-format", "logfmt"],
    url: (text) => /\burl=(https:\/\/[^\s"]+)/.exec(text)?.[1] ?? null,
  },
});

export const PROVIDER_IDS = Object.keys(PROVIDERS);

/** The most useful error line a tunnel printed before it gave up. */
export function tunnelError(provider, log) {
  const lines = String(log).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (provider === "ngrok") {
    if (/ERR_NGROK_4018|authtoken/i.test(log)) return "ngrok needs an account token: run `ngrok config add-authtoken <token>` once.";
    const err = lines.reverse().find((l) => /lvl=(eror|crit)|^ERROR:/i.test(l));
    if (err) return (/err="([^"]+)"/.exec(err)?.[1] ?? err.replace(/^ERROR:\s*/i, "")).slice(0, 300);
  } else {
    const err = lines.reverse().find((l) => /\bERR\b|error|failed/i.test(l));
    if (err) return err.replace(/^\S+\s+ERR\s+/, "").slice(0, 300);
  }
  return `${provider} stopped before it printed a public URL.`;
}

/**
 * Keeps at most one tunnel per port. Injectable for tests:
 * `find(name)` → binary path or null, `spawn(file, args)` → ChildProcess-like,
 * `probe(port)` → "busy" | "free".
 */
export function createTunnelManager({
  find = (name) => findBinary(name),
  spawn = (file, args) => nodeSpawn(file, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }),
  probe = async () => "busy",
  now = () => new Date(),
  startTimeoutMs = START_TIMEOUT_MS,
  watchMs = WATCH_MS,
} = {}) {
  /** port -> { port, provider, url, startedAt, child, ready: Promise, misses } */
  const tunnels = new Map();
  let watcher = null;

  function providers() {
    const out = {};
    for (const id of PROVIDER_IDS) out[id] = !!find(id);
    return out;
  }

  const view = (t) => ({ port: t.port, provider: t.provider, url: t.url, startedAt: t.startedAt, state: t.url ? "running" : "starting" });

  /**
   * Every tunnel this host owns, including ones still waiting for their URL ("starting").
   * Clients decide whether to keep the helper alive from this list, so a starting tunnel
   * must never look like "nothing running".
   */
  function list() {
    return [...tunnels.values()].map(view);
  }

  /** Children sent SIGTERM that haven't exited yet; a forced shutdown must reach them too. */
  const dying = new Set();
  const exited = (c) => c.exitCode !== null || c.signalCode !== null;

  function hardKill(child) {
    try {
      if (!exited(child)) child.kill("SIGKILL");
    } catch {
      /* gone */
    }
  }

  function kill(t) {
    const child = t.child;
    if (!child || exited(child)) return; // never spawned (cancelled early), or already gone
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    dying.add(child);
    child.once?.("exit", () => dying.delete(child));
    // Normal stops get a grace period. This timer dies with the host, which is why
    // stopAll({ force: true }) exists for exit paths.
    const force = setTimeout(() => hardKill(child), STOP_GRACE_MS);
    force.unref?.();
  }

  function stop(port) {
    const t = tunnels.get(port);
    if (!t) return false;
    tunnels.delete(port);
    kill(t);
    syncWatcher();
    return true;
  }

  /**
   * Stop every tunnel. With `force` (host exit) every child — running, starting, or already
   * told to stop and still in its grace period — gets SIGKILL synchronously, because no timer
   * survives process.exit and a SIGTERMed cloudflared could otherwise outlive the host.
   */
  function stopAll({ force = false } = {}) {
    const children = [...tunnels.values()].map((t) => t.child).filter(Boolean);
    for (const port of [...tunnels.keys()]) stop(port);
    if (force) for (const child of new Set([...children, ...dying])) hardKill(child);
  }

  // A tunnel to a server that has stopped only serves errors: close it after two misses in a row.
  async function watch() {
    for (const t of [...tunnels.values()]) {
      if (!t.url) continue;
      const state = await probe(t.port).catch(() => "busy");
      t.misses = state === "free" ? t.misses + 1 : 0;
      if (t.misses >= 2 && tunnels.get(t.port) === t) stop(t.port);
    }
  }

  function syncWatcher() {
    if (tunnels.size && !watcher) {
      watcher = setInterval(() => void watch(), watchMs);
      watcher.unref?.();
    } else if (!tunnels.size && watcher) {
      clearInterval(watcher);
      watcher = null;
    }
  }

  /**
   * Start (or return the running) tunnel for `port`. `target` is the IP literal to forward to,
   * or an async function that finds it (the handler's port/ownership check).
   *
   * The port is registered as "starting" synchronously, before anything is awaited, so a
   * stop that arrives at any point — during the check, after spawn, before the URL — finds
   * it. After every await the start checks it is still registered; if not, it was cancelled:
   * nothing is spawned, or the child is killed, and the start rejects with code "cancelled".
   * Rejects with { code, message } when no provider is installed or the tunnel fails.
   */
  function start(port, target, provider) {
    const existing = tunnels.get(port);
    if (existing) return existing.ready;
    if (tunnels.size >= MAX_TUNNELS) return Promise.reject({ code: "not_permitted", message: `at most ${MAX_TUNNELS} share links at a time` });
    const id = provider ?? PROVIDER_IDS.find((p) => find(p));
    const bin = id ? find(id) : null;
    if (!id || !bin) return Promise.reject({ code: "not_found", message: provider ? `${provider} is not installed` : "neither cloudflared nor ngrok is installed" });

    const t = { port, provider: id, url: null, startedAt: now().toISOString(), child: null, ready: null, misses: 0 };
    tunnels.set(port, t);
    syncWatcher();
    const cancelled = () => tunnels.get(port) !== t;
    const CANCELLED = { code: "cancelled", message: `the share link for port ${port} was cancelled` };

    t.ready = (async () => {
      let host;
      try {
        host = typeof target === "function" ? await target() : target;
      } catch (err) {
        if (tunnels.get(port) === t) tunnels.delete(port);
        syncWatcher();
        throw err;
      }
      if (cancelled()) throw CANCELLED; // stopped during the check: never spawn

      const hostPort = `${host.includes(":") ? `[${host}]` : host}:${port}`;
      const child = spawn(bin, PROVIDERS[id].args(`http://${hostPort}`, hostPort));
      t.child = child;
      return await new Promise((resolve, reject) => {
        let log = "";
        let settled = false;
        const done = (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          // After a stop, every outcome is "cancelled" — a URL that still arrives is never handed out.
          if (cancelled()) err = CANCELLED;
          if (err) {
            if (tunnels.get(port) === t) tunnels.delete(port);
            kill(t);
            syncWatcher();
            reject(err);
          } else resolve(view(t));
        };
        const onData = (chunk) => {
          if (settled) return;
          log = (log + chunk.toString("utf8")).slice(-MAX_LOG);
          const url = PROVIDERS[id].url(log);
          if (url) {
            t.url = url;
            done(null);
          }
        };
        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        child.once("error", (err) =>
          done({ code: err?.code === "ENOENT" ? "not_found" : "internal", message: `could not start ${id}: ${err?.message ?? err}` }),
        );
        // A tunnel that dies after its URL was handed out must leave the list too (done() is a no-op then).
        child.once("exit", () => {
          done({ code: "internal", message: tunnelError(id, log) });
          if (tunnels.get(port) === t) tunnels.delete(port);
          syncWatcher();
        });
        const timer = setTimeout(() => done({ code: "internal", message: `${id} did not print a public URL within ${Math.round(startTimeoutMs / 1000)} s` }), startTimeoutMs);
        timer.unref?.();
        // Stopped between spawn and these listeners (cannot happen synchronously, but cheap to honour).
        if (cancelled()) done(CANCELLED);
      });
    })();
    return t.ready;
  }

  return { providers, list, start, stop, stopAll, watch };
}
