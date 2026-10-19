import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  splitHostPort,
  parseLsofListen,
  parseLsofCwd,
  parsePs,
  parseLstart,
  parseSs,
  parseProcNetTcp,
  parseNetstatWin,
  parseTasklist,
} from "../src/parsers.js";

const fx = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

test("splitHostPort handles v4, v6, wildcard and bad input", () => {
  assert.deepEqual(splitHostPort("127.0.0.1:3000"), { host: "127.0.0.1", port: 3000 });
  assert.deepEqual(splitHostPort("[::1]:5432"), { host: "::1", port: 5432 });
  assert.deepEqual(splitHostPort("*:80"), { host: "*", port: 80 });
  assert.equal(splitHostPort("*:*"), null);
  assert.equal(splitHostPort("nope"), null);
});

test("lsof -F listen output (macOS)", () => {
  const l = parseLsofListen(fx("lsof-listen-darwin.txt"));
  assert.equal(l.length, 12);
  assert.deepEqual(l[0], { port: 53607, address: "*", family: "IPv4", pid: 671, process: "rapportd", user: "mali" });
  assert.deepEqual(l[1].family, "IPv6");
  const onedrive = l.find((x) => x.pid === 978);
  assert.equal(onedrive.process, "OneDrive Sync Service");
  assert.equal(onedrive.address, "::1");
  assert.equal(onedrive.port, 42050);
  const linkLocal = l.find((x) => x.port === 3001);
  assert.equal(linkLocal.address, "fe80::1%lo0");
  assert.equal(linkLocal.family, "IPv6");
  assert.deepEqual(parseLsofListen(""), []);
});

test("lsof cwd output, including paths with spaces", () => {
  const m = parseLsofCwd(fx("lsof-cwd-darwin.txt"));
  assert.equal(m.get(677), "/");
  assert.equal(m.get(14333), "/Users/mali/Documents/my project");
  assert.equal(m.get(92657), "/Users/mali/Projects/web-app");
});

test("ps output with lstart and full args", () => {
  const m = parsePs(fx("ps-darwin.txt"));
  assert.equal(m.size, 3);
  const vite = m.get(92657);
  assert.equal(vite.user, "mali");
  assert.equal(vite.command, "node /Users/mali/Projects/web-app/node_modules/.bin/vite --port 3000");
  assert.equal(vite.startedAt, new Date(2026, 9, 5, 9, 3, 7).toISOString());
  assert.equal(m.get(14333).command, "ssh: /Users/mali/.colima/_lima/colima/ssh.sock [mux]");
  assert.equal(parseLstart("garbage"), null);
});

test("ss -ltnp (Linux)", () => {
  const l = parseSs(fx("ss-linux.txt"));
  const byPort = (p) => l.filter((x) => x.port === p);
  assert.deepEqual(byPort(53)[0], { port: 53, address: "127.0.0.53", family: "IPv4", pid: null, process: null, user: null });
  assert.equal(byPort(3000)[0].pid, 4242);
  assert.equal(byPort(3000)[0].process, "node");
  assert.deepEqual(byPort(8080).map((x) => x.pid), [5001, 5002]);
  assert.equal(byPort(8080)[0].family, "IPv6");
  assert.equal(byPort(5432)[0].address, "::1");
  assert.deepEqual(byPort(22).map((x) => x.family), ["IPv4", "IPv6"]);
});

test("/proc/net/tcp and tcp6 (Linux fallback)", () => {
  const v4 = parseProcNetTcp(fx("proc-net-tcp.txt"), "IPv4");
  assert.deepEqual(v4, [
    { port: 53, address: "127.0.0.53", family: "IPv4", uid: 101, inode: 18563 },
    { port: 3000, address: "127.0.0.1", family: "IPv4", uid: 1000, inode: 99881 },
  ]);
  const v6 = parseProcNetTcp(fx("proc-net-tcp6.txt"), "IPv6");
  assert.deepEqual(v6.map((x) => [x.address, x.port]), [["::1", 5432], ["::", 8080]]);
});

test("netstat -ano (Windows), localized state column", () => {
  const l = parseNetstatWin(fx("netstat-win32.txt"));
  assert.deepEqual(l.map((x) => [x.address, x.port, x.pid, x.family]), [
    ["0.0.0.0", 135, 1048, "IPv4"],
    ["127.0.0.1", 3000, 7312, "IPv4"],
    ["::", 135, 1048, "IPv6"],
    ["::1", 5173, 8120, "IPv6"],
  ]);
});

test("tasklist CSV (Windows)", () => {
  const m = parseTasklist(fx("tasklist-win32.txt"));
  assert.equal(m.get(7312).process, "node.exe");
  assert.equal(m.get(8120).process, "Code Helper.exe");
  assert.equal(m.get(7312).user, null);
  const verbose = parseTasklist('"node.exe","7312","Console","1","45,000 K","Running","DESKTOP\\dev","0:00:01","N/A"\r\n');
  assert.equal(verbose.get(7312).user, "DESKTOP\\dev");
});
