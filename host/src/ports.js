// Port probing (for listeners the OS scan cannot attribute) and free-port suggestions.
import net from "node:net";

// Chrome refuses to load these (net/base/port_util.cc, kRestrictedPorts).
export const CHROME_UNSAFE_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109,
  110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530,
  531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190,
  5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

// Ports conventionally owned by services a developer is likely to start later; don't hand them out.
export const WELL_KNOWN_SERVICE_PORTS = new Set([
  1080, // socks
  1433, // mssql
  1521, // oracle
  1883, // mqtt
  2181, // zookeeper
  2375, 2376, // docker
  3306, // mysql
  3389, // rdp
  4369, // erlang epmd
  5000, 7000, // macOS AirPlay receiver
  5353, // mdns
  5432, // postgres
  5672, 15672, // rabbitmq
  5900, // vnc
  5984, // couchdb
  6379, // redis
  6443, // kubernetes api
  7474, 7687, // neo4j
  8086, // influxdb
  8200, // vault
  8500, // consul
  8883, // mqtt tls
  9042, // cassandra
  9092, // kafka
  9200, 9300, // elasticsearch
  9418, // git
  11211, // memcached
  26257, // cockroachdb
  27017, // mongodb
]);

export const MIN_SUGGEST_PORT = 1024;

export function isValidPort(p) {
  return Number.isInteger(p) && p >= 1 && p <= 65535;
}

function tryBind(host, port) {
  // "busy" on EADDRINUSE, "ok" when the bind worked, "unknown" otherwise (no IPv6, EACCES on <1024, ...).
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once("error", (err) => resolve(err.code === "EADDRINUSE" ? "busy" : "unknown"));
    srv.listen({ host, port, exclusive: true }, () => srv.close(() => resolve("ok")));
  });
}

function tryConnect(host, port, timeout) {
  // "busy" when something accepted the connection.
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (r) => {
      sock.destroy();
      resolve(r);
    };
    sock.setTimeout(timeout, () => done("unknown"));
    sock.once("connect", () => done("busy"));
    sock.once("error", () => done("free"));
  });
}

/**
 * Is anything on this machine listening on `port`? Used when the OS scan shows no owner
 * (other users' / root's sockets are invisible to an unprivileged lsof/ss).
 * Bind catches exclusive binds, connect catches wildcard listeners that SO_REUSEADDR
 * would let us bind beside (BSD/macOS).
 */
export async function probePort(port, { timeout = 250 } = {}) {
  // Connect before binding, and bind one address at a time: our own probe socket
  // must never be what answers (or blocks) another probe.
  const conns = await Promise.all([tryConnect("127.0.0.1", port, timeout), tryConnect("::1", port, timeout)]);
  if (conns.includes("busy")) return "busy";
  for (const host of ["127.0.0.1", "0.0.0.0", "::1"]) {
    if ((await tryBind(host, port)) === "busy") return "busy";
  }
  return "free";
}

/**
 * Candidates ordered by distance from `near` (ties: the higher port first, since dev
 * tools usually count upwards), skipping unsafe, well-known and known-busy ports.
 */
export function* candidatePorts(near, busy = new Set()) {
  const ok = (p) =>
    p >= MIN_SUGGEST_PORT && p <= 65535 && !CHROME_UNSAFE_PORTS.has(p) && !WELL_KNOWN_SERVICE_PORTS.has(p) && !busy.has(p);
  for (let d = 0; d <= 65535; d++) {
    const up = near + d;
    const down = near - d;
    if (up > 65535 && down < MIN_SUGGEST_PORT) return;
    if (ok(up)) yield up;
    if (d > 0 && ok(down)) yield down;
  }
}

/** Free ports nearest to `near`. Probes in small parallel batches to stay fast. */
export async function suggestPorts(near, count, busy, probe = probePort) {
  const out = [];
  const gen = candidatePorts(near, busy);
  while (out.length < count) {
    const batch = [];
    for (let i = 0; i < Math.max(4, count - out.length); i++) {
      const n = gen.next();
      if (n.done) break;
      batch.push(n.value);
    }
    if (batch.length === 0) break;
    const states = await Promise.all(batch.map((p) => probe(p)));
    for (let i = 0; i < batch.length && out.length < count; i++) if (states[i] === "free") out.push(batch[i]);
  }
  return out;
}
