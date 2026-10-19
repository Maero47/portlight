// Request validation and dispatch. All OS access goes through `deps` so it can be faked in tests.
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { scanListeners, windowsProcessUser, processUid, ancestorPids, processPairs, descendantPids } from "./scan.js";
import { createContainerSource, attachContainers, isContainerEngine } from "./containers.js";
import { EDITORS, EDITOR_IDS, editorCommand, revealCommand, launchDetached } from "./launch.js";
import { probePort, suggestPorts, isValidPort } from "./ports.js";
import { PROTOCOL_VERSION, HOST_VERSION } from "./protocol.js";

const MAX_CHECK_PORTS = 1000;
const MAX_SUGGEST = 50;
const DEFAULT_NEAR = 3000;
const DEFAULT_COUNT = 5;
const SCAN_CACHE_MS = 300;
const PROBE_CONCURRENCY = 32;

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

class ProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new ProtocolError(code, message);
};

export function currentUser() {
  try {
    const { username, uid } = os.userInfo();
    return { name: username, uid };
  } catch {
    return { name: null, uid: -1 };
  }
}

/** tasklist reports "DOMAIN\\user"; os.userInfo() gives the bare name. */
export function sameUser(owner, me) {
  if (!owner || !me) return false;
  const strip = (u) => u.split("\\").pop().toLowerCase();
  return owner === me || strip(owner) === strip(me);
}

export function defaultDeps() {
  const me = currentUser();
  let ancestors = null;
  return {
    platform: process.platform,
    scan: () => scanListeners(),
    containers: createContainerSource(),
    processPairs: () => processPairs(),
    launch: (file, args) => launchDetached(file, args),
    isDirectory: async (p) => (await fs.stat(p).catch(() => null))?.isDirectory() ?? false,
    editorCommand: (id, dir) => editorCommand(id, dir),
    probe: (port) => probePort(port),
    signal: (pid, sig) => process.kill(pid, sig),
    user: me.name,
    // Does this pid run as the current user? Unix compares numeric uids, since `ps`
    // may print a uid or a truncated name for long usernames. Windows asks tasklist /V.
    isMine: async (listener) => {
      if (process.platform === "win32") {
        const owner = await windowsProcessUser(listener.pid);
        return { mine: sameUser(owner, me.name), owner };
      }
      const uid = await processUid(listener.pid);
      return { mine: uid !== null && uid === me.uid, owner: listener.user ?? (uid !== null ? `uid ${uid}` : null) };
    },
    // The host and everything above it: on Windows Chrome starts cmd.exe (the .bat
    // launcher) which starts node, so process.ppid alone is not the browser.
    protectedPids: async () => {
      ancestors ??= ancestorPids(process.pid).catch(() => new Set());
      return new Set([process.pid, process.ppid, ...(await ancestors)]);
    },
  };
}

/** Pick the most informative listener when several share a port (prefer ones with a pid). */
function bestListener(list) {
  return list.find((l) => l.pid != null) ?? list[0];
}

export function createHandler(overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides };

  // OS scan and container lookup run side by side; a broken engine CLI never fails a scan.
  async function scanWithContainers() {
    const [listeners, published] = await Promise.all([
      deps.scan(),
      Promise.resolve()
        .then(() => (deps.containers ? deps.containers() : []))
        .catch(() => []),
    ]);
    return attachContainers(listeners, published, deps.probe);
  }

  // Share one scan between requests that arrive close together (popup opens -> list + check).
  let cache = null;
  function scan() {
    const now = Date.now();
    if (cache && (cache.pending || now - cache.at < SCAN_CACHE_MS)) return cache.promise;
    const entry = { at: now, pending: true, promise: null };
    entry.promise = Promise.resolve()
      .then(scanWithContainers)
      .finally(() => {
        entry.pending = false;
        entry.at = Date.now();
      });
    entry.promise.catch(() => {
      if (cache === entry) cache = null;
    });
    cache = entry;
    return entry.promise;
  }
  const freshScan = () => {
    cache = null;
    return scan();
  };

  const handlers = {
    async ping(req) {
      return { id: req.id, ok: true, type: "pong", version: PROTOCOL_VERSION, platform: deps.platform, hostVersion: HOST_VERSION };
    },

    async list(req) {
      const listeners = await scan();
      return { id: req.id, ok: true, type: "list", listeners, scannedAt: new Date().toISOString() };
    },

    async check(req) {
      const { ports } = req;
      if (!Array.isArray(ports) || ports.length === 0) fail("bad_request", "check needs a non-empty `ports` array");
      if (ports.length > MAX_CHECK_PORTS) fail("bad_request", `check accepts at most ${MAX_CHECK_PORTS} ports`);
      const bad = ports.find((p) => !isValidPort(p));
      if (bad !== undefined) fail("bad_request", `invalid port: ${JSON.stringify(bad)}`);

      const listeners = await scan();
      const results = await mapLimit(ports, PROBE_CONCURRENCY, async (port) => {
          const owners = listeners.filter((l) => l.port === port);
          if (owners.length) return { port, free: false, listener: bestListener(owners) };
          // Not visible in the scan (e.g. owned by root or another user): ask the network stack.
          const state = await deps.probe(port);
          return { port, free: state !== "busy" };
      });
      return { id: req.id, ok: true, type: "check", results };
    },

    async suggest(req) {
      const near = req.near ?? DEFAULT_NEAR;
      const count = req.count ?? DEFAULT_COUNT;
      if (!isValidPort(near)) fail("bad_request", "`near` must be an integer port 1-65535");
      if (!Number.isInteger(count) || count < 1 || count > MAX_SUGGEST) fail("bad_request", `\`count\` must be 1-${MAX_SUGGEST}`);
      const busy = new Set((await scan()).map((l) => l.port));
      const ports = await suggestPorts(near, count, busy, deps.probe);
      return { id: req.id, ok: true, type: "suggest", ports };
    },

    async kill(req) {
      const { pid } = req;
      const signal = req.signal ?? "TERM";
      if (signal !== "TERM" && signal !== "KILL") fail("bad_request", "`signal` must be TERM or KILL");
      if (req.tree !== undefined && typeof req.tree !== "boolean") fail("bad_request", "`tree` must be a boolean");
      const prot = await protectedSet();
      if (Number.isInteger(pid) && prot.has(pid)) fail("not_permitted", `refusing to kill pid ${pid} (the host or a process that launched it, e.g. the browser)`);
      const listener = await ownedListener(pid);
      if (isContainerEngine(listener)) {
        fail("not_permitted", `pid ${pid} (${listener.process ?? "container engine"}) forwards ports for containers; stopping it would cut them all off. Stop the container instead`);
      }

      // Snapshot the tree before signalling: once the parent dies its children are
      // re-parented and can no longer be found from it.
      const descendants = req.tree ? descendantPids(pid, await deps.processPairs()) : [];
      const sig = signal === "KILL" ? "SIGKILL" : "SIGTERM";
      try {
        deps.signal(pid, sig);
      } catch (err) {
        if (err.code === "ESRCH") fail("not_found", `pid ${pid} has already exited`);
        if (err.code === "EPERM") fail("not_permitted", `not allowed to signal pid ${pid}`);
        throw err;
      }
      const killed = [pid];
      // Parent first, so supervisors (nodemon, turbo) are already shutting down and
      // don't restart the children we stop next. Same rules per child: not protected, same user.
      const allowed = await mapLimit(descendants, 8, async (child) => {
        if (prot.has(child)) return false;
        return (await deps.isMine({ pid: child, user: null })).mine;
      });
      for (let i = 0; i < descendants.length; i++) {
        if (!allowed[i]) continue;
        try {
          deps.signal(descendants[i], sig);
          killed.push(descendants[i]);
        } catch {
          // already gone, or not ours after all: skip
        }
      }
      cache = null;
      return { id: req.id, ok: true, type: "kill", pid, killed };
    },

    async reveal(req) {
      const dir = await projectDir(req.pid);
      const { file, args } = revealCommand(deps.platform, dir);
      await launch(file, args, "the file manager");
      return { id: req.id, ok: true, type: "reveal", path: dir };
    },

    async openEditor(req) {
      const { editor } = req;
      if (typeof editor !== "string" || !Object.hasOwn(EDITORS, editor)) {
        fail("bad_request", `\`editor\` must be one of: ${EDITOR_IDS.join(", ")}`);
      }
      const dir = await projectDir(req.pid);
      const cmd = await deps.editorCommand(editor, dir);
      if (!cmd) fail("not_found", `${EDITORS[editor].label} is not installed (or its command-line tool is not on PATH)`);
      await launch(cmd.file, cmd.args, EDITORS[editor].label);
      return { id: req.id, ok: true, type: "openEditor", path: dir };
    },
  };

  async function protectedSet() {
    return typeof deps.protectedPids === "function" ? await deps.protectedPids() : deps.protectedPids;
  }

  /** The pid must own a listening port right now (fresh scan) and run as the current user. */
  async function ownedListener(pid) {
    if (!Number.isInteger(pid) || pid <= 0) fail("bad_request", "`pid` must be a positive integer");
    const owned = (await freshScan()).filter((l) => l.pid === pid);
    if (owned.length === 0) fail("not_found", `pid ${pid} does not own a listening TCP port`);
    const { mine, owner } = await deps.isMine(owned[0]);
    if (!mine) {
      fail("not_permitted", `pid ${pid} belongs to ${owner ?? "an unknown user"}, not ${deps.user ?? "the current user"}`);
    }
    return owned[0];
  }

  /** Working directory of a listener the user owns; refuses container forwarders (their cwd is not a project). */
  async function projectDir(pid) {
    const listener = await ownedListener(pid);
    if (isContainerEngine(listener)) fail("not_permitted", `pid ${pid} is a container engine, not a project process`);
    const dir = listener.cwd;
    if (!dir || !path.isAbsolute(dir)) fail("not_found", `working directory of pid ${pid} is unknown`);
    if (!(await deps.isDirectory(dir))) fail("not_found", `${dir} no longer exists`);
    return dir;
  }

  async function launch(file, args, what) {
    try {
      await deps.launch(file, args);
    } catch (err) {
      if (err?.code === "ENOENT") fail("not_found", `could not start ${what}: ${path.basename(file)} not found`);
      throw err;
    }
  }

  /** Never throws: always resolves to a protocol Response. */
  return async function handle(req) {
    const id = req && typeof req === "object" && typeof req.id === "string" ? req.id : "";
    try {
      if (!req || typeof req !== "object" || Array.isArray(req)) fail("bad_request", "request must be a JSON object");
      if (typeof req.id !== "string" || req.id.length === 0 || req.id.length > 200) fail("bad_request", "`id` must be a non-empty string");
      const h = Object.hasOwn(handlers, req.type) ? handlers[req.type] : null;
      if (!h) fail("bad_request", `unknown request type: ${JSON.stringify(req.type)}`);
      return await h(req);
    } catch (err) {
      if (err instanceof ProtocolError) return { id, ok: false, error: { code: err.code, message: err.message } };
      return { id, ok: false, error: { code: "internal", message: String(err?.message ?? err) } };
    }
  };
}
