// Pure parsers for OS tool output. No I/O here so they can be tested against fixtures.

/** Split "host:port" where host may be "[v6]", "*", or contain "%iface". */
export function splitHostPort(s) {
  const i = s.lastIndexOf(":");
  if (i < 0) return null;
  let host = s.slice(0, i);
  const port = Number(s.slice(i + 1));
  if (!Number.isInteger(port) || port < 0 || port > 65535) return null;
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  return { host, port };
}

function familyOf(host, fallback) {
  if (host === "*") return fallback;
  return host.includes(":") ? "IPv6" : "IPv4";
}

/**
 * `lsof -nP -iTCP -sTCP:LISTEN -F pcLtn`
 * Records: p<pid>, c<command>, L<login>, then per fd: f<fd>, t<IPv4|IPv6>, n<addr:port>.
 */
export function parseLsofListen(text) {
  const out = [];
  let proc = null;
  let type = null;
  for (const line of text.split("\n")) {
    if (!line) continue;
    const tag = line[0];
    const val = line.slice(1);
    switch (tag) {
      case "p":
        proc = { pid: Number(val), process: null, user: null };
        type = null;
        break;
      case "c":
        if (proc) proc.process = val;
        break;
      case "L":
        if (proc) proc.user = val;
        break;
      case "f":
        type = null;
        break;
      case "t":
        type = val;
        break;
      case "n": {
        if (!proc) break;
        // Listening sockets have no "->"; skip anything else defensively.
        if (val.includes("->")) break;
        const hp = splitHostPort(val);
        if (!hp) break;
        const family = type === "IPv6" || type === "IPv4" ? type : familyOf(hp.host, "IPv4");
        out.push({
          port: hp.port,
          address: hp.host,
          family,
          pid: proc.pid,
          process: proc.process,
          user: proc.user,
        });
        break;
      }
    }
  }
  return out;
}

/** `lsof -a -p <pids> -d cwd -Fn` -> Map<pid, cwd> */
export function parseLsofCwd(text) {
  const map = new Map();
  let pid = null;
  for (const line of text.split("\n")) {
    if (line[0] === "p") pid = Number(line.slice(1));
    else if (line[0] === "n" && pid != null) map.set(pid, line.slice(1));
  }
  return map;
}

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

/** Parse ps `lstart` ("Mon Oct  5 09:03:07 2026", local time, LC_ALL=C) to ISO. */
export function parseLstart(s) {
  const m = /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(s.trim());
  if (!m || !(m[1] in MONTHS)) return null;
  const d = new Date(Number(m[6]), MONTHS[m[1]], Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** `LC_ALL=C ps -o pid=,user=,lstart=,args= -p <pids>` -> Map<pid, {user, startedAt, command}> */
export function parsePs(text) {
  const map = new Map();
  const re = /^\s*(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/;
  for (const line of text.split("\n")) {
    const m = re.exec(line);
    if (!m) continue;
    map.set(Number(m[1]), { user: m[2], startedAt: parseLstart(m[3]), command: m[4].trim() || null });
  }
  return map;
}

/** `ss -ltnp` (header optional). Each socket may have several owning processes. */
export function parseSs(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("LISTEN")) continue;
    const cols = line.trim().split(/\s+/);
    // State Recv-Q Send-Q Local Peer [Process...]
    if (cols.length < 5) continue;
    const hp = splitHostPort(cols[3]);
    if (!hp) continue;
    let host = hp.host.replace(/%.*$/, ""); // 127.0.0.53%lo -> 127.0.0.53
    const family = host === "*" ? "IPv6" : familyOf(host, "IPv4"); // "*" in ss is a dual-stack v6 socket
    const procText = cols.slice(5).join(" ");
    const owners = [...procText.matchAll(/\("([^"]*)",pid=(\d+)/g)].map((m) => ({ process: m[1], pid: Number(m[2]) }));
    if (owners.length === 0) owners.push({ process: null, pid: null });
    const seen = new Set();
    for (const o of owners) {
      if (seen.has(o.pid)) continue;
      seen.add(o.pid);
      out.push({ port: hp.port, address: host, family, pid: o.pid, process: o.process, user: null });
    }
  }
  return out;
}

function hexToIPv4(hex) {
  // Little-endian 32-bit word.
  const b = [0, 2, 4, 6].map((i) => parseInt(hex.slice(i, i + 2), 16)).reverse();
  return b.join(".");
}

function hexToIPv6(hex) {
  // Four little-endian 32-bit words.
  const bytes = [];
  for (let w = 0; w < 4; w++) {
    const word = hex.slice(w * 8, w * 8 + 8);
    for (let i = 6; i >= 0; i -= 2) bytes.push(parseInt(word.slice(i, i + 2), 16));
  }
  const groups = [];
  for (let i = 0; i < 16; i += 2) groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
  // Compress the longest run of zero groups.
  let best = [-1, 0];
  for (let i = 0; i < 8; ) {
    if (groups[i] !== "0") { i++; continue; }
    let j = i;
    while (j < 8 && groups[j] === "0") j++;
    if (j - i > best[1]) best = [i, j - i];
    i = j;
  }
  if (best[1] < 2) return groups.join(":");
  const head = groups.slice(0, best[0]).join(":");
  const tail = groups.slice(best[0] + best[1]).join(":");
  return `${head}::${tail}`;
}

/** /proc/net/tcp or /proc/net/tcp6 -> listeners (state 0A) with socket inode and uid. */
export function parseProcNetTcp(text, family) {
  const out = [];
  for (const line of text.split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 10 || cols[3] !== "0A") continue;
    const [addrHex, portHex] = cols[1].split(":");
    const address = family === "IPv6" ? hexToIPv6(addrHex) : hexToIPv4(addrHex);
    out.push({ port: parseInt(portHex, 16), address, family, uid: Number(cols[7]), inode: Number(cols[9]) });
  }
  return out;
}

/**
 * `netstat -ano` on Windows. The State column is localized, so a TCP row counts as
 * listening when its foreign port is 0 (true only for LISTENING rows).
 */
export function parseNetstatWin(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const cols = raw.trim().split(/\s+/);
    if (cols[0] !== "TCP" || cols.length < 5) continue;
    const local = splitHostPort(cols[1]);
    const foreign = splitHostPort(cols[2]);
    if (!local || !foreign || foreign.port !== 0) continue;
    const pid = Number(cols[cols.length - 1]);
    out.push({
      port: local.port,
      address: local.host,
      family: familyOf(local.host, "IPv4"),
      pid: Number.isInteger(pid) && pid > 0 ? pid : null,
      process: null,
      user: null,
    });
  }
  return out;
}

/** Parse one CSV row with quoted fields (tasklist output). */
function csvRow(line) {
  const out = [];
  const re = /"((?:[^"]|"")*)"/g;
  let m;
  while ((m = re.exec(line))) out.push(m[1].replace(/""/g, '"'));
  return out;
}

/** `tasklist /FO CSV /NH` (optionally /V) -> Map<pid, {process, user}> */
export function parseTasklist(text) {
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const cols = csvRow(line);
    if (cols.length < 2) continue;
    const pid = Number(cols[1]);
    if (!Number.isInteger(pid)) continue;
    // Verbose format: Image, PID, Session, Session#, Mem, Status, User Name, CPU Time, Window Title
    const user = cols.length >= 9 ? cols[6] : null;
    map.set(pid, { process: cols[0], user: user && user !== "N/A" ? user : null });
  }
  return map;
}
