// Maps published host ports to Docker / OrbStack / Colima / Podman containers.
// Asks the engine CLI (`docker ps`, `podman ps`) with a tight timeout and caches the answer,
// so a stopped or missing engine never slows `list` down.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "./scan.js";

const CLI_TIMEOUT_MS = 1000; // a healthy `docker ps` answers in ~100 ms
const OK_TTL_MS = 3000; // containers come and go; keep it short
const FAIL_TTL_MS = 15000; // engine stopped / not installed: don't retry on every popup open
const MAX_RANGE = 1024; // "8000-9000->8000-9000/tcp" expands to at most this many ports

/**
 * Processes that forward published ports from a container VM / namespace to the host:
 * Docker Desktop (com.docker.backend, vpnkit), Linux docker-proxy, OrbStack, Colima/Lima
 * (limactl, or an ssh mux on the lima socket), Podman (gvproxy, rootlessport, conmon).
 */
export function isContainerEngine(listener) {
  const name = (listener?.process ?? "").toLowerCase();
  const cmd = (listener?.command ?? "").toLowerCase();
  if (/^com\.docker\./.test(name) || /^(vpnkit|docker-proxy|gvproxy|rootlessport|conmon|limactl|podman)/.test(name)) return true;
  if (name.startsWith("orbstack") || /\/orbstack\.app\//.test(cmd)) return true;
  if (/\/docker\.app\/contents\/|\bcom\.docker\.backend\b|\bvpnkit\b|\bdocker-proxy\b/.test(cmd)) return true;
  // Colima / Lima with the ssh port forwarder: "ssh: ~/.colima/_lima/colima/ssh.sock [mux]".
  if (name === "ssh" && /(\/\.lima\/|\/_lima\/|\/\.colima\/)/.test(cmd)) return true;
  return false;
}

/**
 * Docker's "Ports" column: "0.0.0.0:9000-9001->9000-9001/tcp, [::]:5433->5432/tcp, 1110/tcp".
 * Returns published TCP ports only (unpublished "1110/tcp" has no host side).
 */
export function parseDockerPorts(text) {
  const out = [];
  for (const part of String(text ?? "").split(/,\s*/)) {
    const m = /^(.*):(\d+)(?:-(\d+))?->(\d+)(?:-(\d+))?\/(\w+)$/.exec(part.trim());
    if (!m || m[6] !== "tcp") continue;
    let hostIp = m[1];
    if (hostIp.startsWith("[") && hostIp.endsWith("]")) hostIp = hostIp.slice(1, -1);
    const hostFrom = Number(m[2]);
    const hostTo = m[3] ? Number(m[3]) : hostFrom;
    const ctrFrom = Number(m[4]);
    const ctrTo = m[5] ? Number(m[5]) : ctrFrom;
    const n = Math.min(hostTo - hostFrom, MAX_RANGE - 1);
    for (let i = 0; i <= n; i++) {
      out.push({ hostIp, hostPort: hostFrom + i, containerPort: ctrTo - ctrFrom === hostTo - hostFrom ? ctrFrom + i : ctrFrom });
    }
  }
  return out;
}

/** Docker labels arrive as one "k=v,k=v" string; values may contain commas, so match by key. */
function labelFrom(labels, key) {
  if (labels && typeof labels === "object") return labels[key] ?? null;
  if (typeof labels !== "string") return null;
  const re = new RegExp(`(?:^|,)${key.replace(/\./g, "\\.")}=([^,]*)`);
  const m = re.exec(labels);
  return m ? m[1] || null : null;
}

function portsFromPodman(ports) {
  const out = [];
  for (const p of Array.isArray(ports) ? ports : []) {
    if ((p.protocol ?? "tcp") !== "tcp" || !p.host_port) continue;
    const range = Math.min(Math.max(1, p.range ?? 1), MAX_RANGE);
    for (let i = 0; i < range; i++) {
      out.push({ hostIp: p.host_ip || "0.0.0.0", hostPort: p.host_port + i, containerPort: p.container_port + i });
    }
  }
  return out;
}

function containerRecord(c) {
  // Docker: {ID, Names:"a,b", Image, Ports:"…", Labels:"k=v,…", State}
  // Podman: {Id, Names:["a"], Image, Ports:[{host_ip,host_port,container_port,range,protocol}], Labels:{}, State}
  const id = String(c.ID ?? c.Id ?? "").slice(0, 12);
  const names = Array.isArray(c.Names) ? c.Names : String(c.Names ?? "").split(",");
  const state = String(c.State ?? "running").toLowerCase();
  if (!id || state !== "running") return null;
  const labels = c.Labels;
  return {
    id,
    name: (names[0] ?? "").replace(/^\//, "") || id,
    image: String(c.Image ?? ""),
    project: labelFrom(labels, "com.docker.compose.project") ?? labelFrom(labels, "io.podman.compose.project"),
    workingDir: labelFrom(labels, "com.docker.compose.project.working_dir"),
    ports: Array.isArray(c.Ports) ? portsFromPodman(c.Ports) : parseDockerPorts(c.Ports),
  };
}

/**
 * `docker ps --format '{{json .}}'` (one object per line) or `podman ps --format json`
 * (one array) -> [{hostIp, hostPort, container: ContainerInfo}] for running containers.
 */
export function parseContainerPs(text) {
  const raw = [];
  const trimmed = String(text ?? "").trim();
  if (trimmed.startsWith("[")) {
    try {
      raw.push(...JSON.parse(trimmed));
    } catch {
      // ignore
    }
  } else {
    for (const line of trimmed.split("\n")) {
      if (!line.trim()) continue;
      try {
        raw.push(JSON.parse(line));
      } catch {
        // skip a broken line, keep the rest
      }
    }
  }
  const out = [];
  for (const c of raw) {
    const rec = c && typeof c === "object" ? containerRecord(c) : null;
    if (!rec) continue;
    for (const p of rec.ports) {
      out.push({
        hostIp: p.hostIp,
        hostPort: p.hostPort,
        container: { id: rec.id, name: rec.name, image: rec.image, project: rec.project, containerPort: p.containerPort, workingDir: rec.workingDir },
      });
    }
  }
  return out;
}

/**
 * Browsers start the host with a minimal PATH (/usr/bin:/bin on macOS), so also look
 * where Homebrew, Docker Desktop, OrbStack and Rancher Desktop put their CLIs.
 */
export function binDirs({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const fromPath = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  if (platform === "win32") return fromPath;
  const extra = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/snap/bin",
    path.join(home, ".local/bin"),
    path.join(home, ".orbstack/bin"),
    path.join(home, ".docker/bin"),
    path.join(home, ".rd/bin"),
    "/Applications/Docker.app/Contents/Resources/bin",
    "/Applications/OrbStack.app/Contents/MacOS/xbin",
  ];
  return [...new Set([...fromPath, ...extra])];
}

export function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** First executable named `name` in `dirs`, or null. On Windows only real .exe files (no .cmd shims). */
export function findBinary(name, { platform = process.platform, dirs = binDirs({ platform }), exists = isExecutable } = {}) {
  const names = platform === "win32" ? [`${name}.exe`] : [name];
  for (const d of dirs) for (const n of names) {
    const f = path.join(d, n);
    if (exists(f)) return f;
  }
  return null;
}

/**
 * Returns `() => Promise<published[]>`, sharing one in-flight CLI call and caching the
 * result (short TTL on success, longer on failure). Never rejects.
 */
export function createContainerSource({ exec = run, find = findBinary, now = Date.now } = {}) {
  let cache = null;
  async function query() {
    const jobs = [];
    const docker = find("docker");
    if (docker) jobs.push(exec(docker, ["ps", "--format", "{{json .}}"], { timeout: CLI_TIMEOUT_MS, strict: true }));
    const podman = find("podman");
    if (podman) jobs.push(exec(podman, ["ps", "--format", "json"], { timeout: CLI_TIMEOUT_MS, strict: true }));
    if (jobs.length === 0) return { ok: false, list: [] };
    const results = await Promise.allSettled(jobs);
    const list = results.flatMap((r) => (r.status === "fulfilled" ? parseContainerPs(r.value) : []));
    return { ok: results.some((r) => r.status === "fulfilled"), list };
  }
  return function containers() {
    const t = now();
    if (cache && (cache.pending || t - cache.at < (cache.ok ? OK_TTL_MS : FAIL_TTL_MS))) return cache.promise;
    const entry = { at: t, ok: false, pending: true, promise: null };
    entry.promise = query()
      .catch(() => ({ ok: false, list: [] }))
      .then((r) => {
        entry.ok = r.ok;
        entry.at = now();
        entry.pending = false;
        return r.list;
      });
    cache = entry;
    return entry.promise;
  };
}

function familyOf(ip) {
  return ip.includes(":") ? "IPv6" : "IPv4";
}

/**
 * Adds `container` to listeners whose port is published by a running container, when
 * the listener is the engine's forwarder or has no visible owner (root's docker-proxy).
 * Published ports with no listener at all (iptables-only Docker on Linux) are added as
 * owner-less listeners when `probe` confirms something answers there.
 */
export async function attachContainers(listeners, published, probe) {
  const byPort = new Map();
  for (const p of published) {
    const list = byPort.get(p.hostPort) ?? [];
    list.push(p);
    byPort.set(p.hostPort, list);
  }
  const seenPorts = new Set();
  const out = listeners.map((l) => {
    seenPorts.add(l.port);
    const cands = byPort.get(l.port);
    if (!cands || !(l.pid == null || isContainerEngine(l))) return { ...l, container: l.container ?? null };
    const best = cands.find((c) => c.hostIp === l.address) ?? cands[0];
    // The forwarder's own cwd (wherever the engine was started) is not a project hint.
    return { ...l, cwd: l.pid == null ? l.cwd : null, container: best.container };
  });

  const missing = [];
  for (const [port, cands] of byPort) {
    if (seenPorts.has(port)) continue;
    const seenFam = new Set();
    for (const c of cands) {
      const address = c.hostIp || "0.0.0.0";
      const family = familyOf(address);
      if (seenFam.has(family)) continue;
      seenFam.add(family);
      missing.push({ port, address, family, pid: null, process: null, command: null, cwd: null, user: null, startedAt: null, container: c.container });
    }
  }
  if (missing.length && probe) {
    const states = new Map();
    await Promise.all([...new Set(missing.map((m) => m.port))].map(async (p) => states.set(p, await probe(p).catch(() => "unknown"))));
    for (const m of missing) if (states.get(m.port) === "busy") out.push(m);
    out.sort((a, b) => a.port - b.port || a.family.localeCompare(b.family) || (a.pid ?? 0) - (b.pid ?? 0));
  }
  return out;
}
