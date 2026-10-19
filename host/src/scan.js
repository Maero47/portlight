// Collects TCP listeners from the OS, enriched with process details where visible.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import {
  parseLsofListen,
  parseLsofCwd,
  parsePs,
  parseSs,
  parseProcNetTcp,
  parseNetstatWin,
  parseTasklist,
  parsePidPairs,
} from "./parsers.js";

const MAX_COMMAND = 2000; // keep list responses well under Chrome's 1 MB limit

/**
 * Run a command and resolve its stdout. Non-zero exit with output still resolves
 * (lsof exits 1 when some pids are gone or nothing matched).
 */
export function run(cmd, args, { timeout = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: "C", LANG: "C" }, windowsHide: true },
      (err, stdout) => {
        if (!err) return resolve(stdout);
        // Non-zero exit (lsof exits 1 on "no matches" or vanished pids): keep what it printed.
        // Spawn failures (ENOENT) and timeouts reject.
        if (typeof err.code === "number" && !err.killed) return resolve(stdout || "");
        reject(err);
      },
    );
  });
}

function finalize(entries) {
  // Dedupe (same socket can be reported per fd/thread) and normalise shape.
  const seen = new Set();
  const out = [];
  for (const e of entries) {
    const key = `${e.pid}|${e.family}|${e.address}|${e.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let command = e.command ?? null;
    if (command && command.length > MAX_COMMAND) command = command.slice(0, MAX_COMMAND) + "…";
    out.push({
      port: e.port,
      address: e.address,
      family: e.family,
      pid: e.pid ?? null,
      process: e.process ?? null,
      command,
      cwd: e.cwd ?? null,
      user: e.user ?? null,
      startedAt: e.startedAt ?? null,
    });
  }
  out.sort((a, b) => a.port - b.port || a.family.localeCompare(b.family) || (a.pid ?? 0) - (b.pid ?? 0));
  return out;
}

function uniquePids(entries) {
  return [...new Set(entries.map((e) => e.pid).filter((p) => Number.isInteger(p) && p > 0))];
}

// procps (Linux) prints the numeric uid when a name is wider than the default 8-char
// column, so ask for a wide one there. BSD/macOS ps has no width syntax and doesn't truncate.
export function psFormat(platform) {
  return platform === "linux" ? "pid=,user:64=,lstart=,args=" : "pid=,user=,lstart=,args=";
}

async function psDetails(exec, pids, platform) {
  if (pids.length === 0) return new Map();
  try {
    return parsePs(await exec("ps", ["-o", psFormat(platform), "-p", pids.join(",")]));
  } catch {
    return new Map();
  }
}

function merge(entries, ps, cwds) {
  for (const e of entries) {
    const p = ps.get(e.pid);
    if (p) {
      e.user ??= p.user;
      e.startedAt = p.startedAt;
      e.command = p.command;
    }
    if (cwds.has(e.pid)) e.cwd = cwds.get(e.pid);
    if (!e.process && e.command) {
      // Fall back to basename of argv[0].
      e.process = e.command.split(/\s+/)[0].split("/").pop() || null;
    }
  }
  return entries;
}

async function scanDarwin(exec) {
  const entries = parseLsofListen(await exec("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcLtn"]));
  const pids = uniquePids(entries);
  if (pids.length === 0) return entries;
  const [cwds, ps] = await Promise.all([
    exec("lsof", ["-a", "-p", pids.join(","), "-d", "cwd", "-Fn"]).then(parseLsofCwd, () => new Map()),
    psDetails(exec, pids, "darwin"),
  ]);
  return merge(entries, ps, cwds);
}

async function linuxCwds(pids, readlink) {
  const map = new Map();
  await Promise.all(
    pids.map(async (pid) => {
      try {
        map.set(pid, await readlink(`/proc/${pid}/cwd`));
      } catch {
        // other users' processes are not readable; leave cwd null
      }
    }),
  );
  return map;
}

/** Fallback when `ss` is missing: /proc/net/tcp{,6} + an inode -> pid map from /proc/<pid>/fd. */
async function scanProc(fsx) {
  const entries = [];
  for (const [file, family] of [["/proc/net/tcp", "IPv4"], ["/proc/net/tcp6", "IPv6"]]) {
    try {
      entries.push(...parseProcNetTcp(await fsx.readFile(file, "utf8"), family));
    } catch {
      // tcp6 may not exist
    }
  }
  const wanted = new Set(entries.map((e) => e.inode));
  const owner = new Map();
  let dirs = [];
  try {
    dirs = (await fsx.readdir("/proc")).filter((d) => /^\d+$/.test(d));
  } catch {
    // no /proc
  }
  await Promise.all(
    dirs.map(async (d) => {
      let fds;
      try {
        fds = await fsx.readdir(`/proc/${d}/fd`);
      } catch {
        return;
      }
      for (const fd of fds) {
        try {
          const m = /^socket:\[(\d+)\]$/.exec(await fsx.readlink(`/proc/${d}/fd/${fd}`));
          if (m && wanted.has(Number(m[1])) && !owner.has(Number(m[1]))) owner.set(Number(m[1]), Number(d));
        } catch {
          // fd closed meanwhile
        }
      }
    }),
  );
  return entries.map((e) => ({ port: e.port, address: e.address, family: e.family, pid: owner.get(e.inode) ?? null, process: null, user: null }));
}

async function scanLinux(exec, fsx) {
  let entries;
  try {
    entries = parseSs(await exec("ss", ["-ltnp"]));
  } catch {
    entries = await scanProc(fsx);
  }
  const pids = uniquePids(entries);
  if (pids.length === 0) return entries;
  const [cwds, ps] = await Promise.all([linuxCwds(pids, (p) => fsx.readlink(p)), psDetails(exec, pids, "linux")]);
  return merge(entries, ps, cwds);
}

async function scanWin32(exec) {
  const [netstat, tasks] = await Promise.all([
    exec("netstat", ["-ano", "-p", "TCP"]).then(async (v4) => v4 + "\n" + (await exec("netstat", ["-ano", "-p", "TCPv6"]).catch(() => ""))),
    exec("tasklist", ["/FO", "CSV", "/NH"]).then(parseTasklist, () => new Map()),
  ]);
  const entries = parseNetstatWin(netstat);
  for (const e of entries) {
    const t = tasks.get(e.pid);
    if (t) e.process = t.process;
    if (e.pid === 0 || e.pid === 4) e.process ??= "System";
  }
  return entries;
}

/**
 * Returns all TCP listeners in protocol `Listener` shape.
 * `exec` and `fs` are injectable for tests.
 */
export async function scanListeners({ platform = process.platform, exec = run, fsx = fs } = {}) {
  let entries;
  if (platform === "darwin" || platform === "freebsd" || platform === "openbsd") entries = await scanDarwin(exec);
  else if (platform === "linux") entries = await scanLinux(exec, fsx);
  else if (platform === "win32") entries = await scanWin32(exec);
  else throw new Error(`unsupported platform: ${platform}`);
  return finalize(entries);
}

/** Unix: numeric uid of a pid (reliable even when `ps` would print a truncated name), or null. */
export async function processUid(pid, exec = run) {
  try {
    // Empty output (pid gone) must not become Number("") === 0, i.e. root.
    const m = /^\s*(\d+)\s*$/.exec(await exec("ps", ["-o", "uid=", "-p", String(pid)]));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Pids from `pid` up through its ancestors (the host, its launcher shell, the browser, ...).
 * Unix: `ps -A -o pid=,ppid=`. Windows: Win32_Process via PowerShell (slow, so callers cache it).
 */
export async function ancestorPids(pid, { platform = process.platform, exec = run } = {}) {
  const parent = new Map();
  try {
    if (platform === "win32") {
      const out = await exec(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId)\" }"],
        { timeout: 10000 },
      );
      for (const [k, v] of parsePidPairs(out)) parent.set(k, v);
    } else {
      for (const [k, v] of parsePidPairs(await exec("ps", ["-A", "-o", "pid=,ppid="]))) parent.set(k, v);
    }
  } catch {
    // fall through with what we know
  }
  const chain = new Set();
  for (let p = pid; p > 0 && !chain.has(p); p = parent.get(p) ?? 0) chain.add(p);
  return chain;
}

/** Windows only: the owning user of one pid ("DOMAIN\\user"), or null. */
export async function windowsProcessUser(pid, exec = run) {
  try {
    const out = await exec("tasklist", ["/V", "/FO", "CSV", "/NH", "/FI", `PID eq ${pid}`]);
    const row = parseTasklist(out).get(pid);
    if (!row || row.columns < 9) return null; // not the verbose format: can't tell
    return row.user;
  } catch {
    return null;
  }
}
