import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { processUid, ancestorPids, windowsProcessUser, psFormat } from "../src/scan.js";

const fx = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const fakeExec = (table) => async (cmd, args) => {
  const key = [cmd, ...args].join(" ");
  for (const [k, v] of Object.entries(table)) if (key.startsWith(k)) return v;
  const e = new Error(`unexpected: ${key}`);
  e.code = "ENOENT";
  throw e;
};

test("Linux ps asks for a wide user column; BSD ps does not get the unsupported syntax", () => {
  assert.match(psFormat("linux"), /user:64=/);
  assert.doesNotMatch(psFormat("darwin"), /:64/);
});

test("processUid reads the numeric uid (immune to truncated usernames)", async () => {
  assert.equal(await processUid(42, fakeExec({ "ps -o uid= -p 42": "  1000\n" })), 1000);
  assert.equal(await processUid(42, fakeExec({ "ps -o uid= -p 42": "" })), null);
  assert.equal(await processUid(42, fakeExec({})), null);
  assert.equal(await processUid(process.pid), process.getuid?.() ?? null);
});

test("ancestorPids walks parents up to the root (Unix and Windows sources)", async () => {
  const unix = fakeExec({ "ps -A -o pid=,ppid=": "    1     0\n  300     1\n  400   300\n  500   400\n  999     1\n" });
  assert.deepEqual([...(await ancestorPids(500, { platform: "darwin", exec: unix }))], [500, 400, 300, 1]);
  // Windows: Chrome (300) -> cmd.exe (400, the .bat launcher) -> node (500)
  const win = fakeExec({ "powershell.exe": "4 0\r\n300 4\r\n400 300\r\n500 400\r\n" });
  assert.deepEqual([...(await ancestorPids(500, { platform: "win32", exec: win }))], [500, 400, 300, 4]);
  // A pid-reuse cycle must not loop forever.
  const cyc = fakeExec({ "ps -A -o pid=,ppid=": "10 20\n20 10\n" });
  assert.deepEqual([...(await ancestorPids(10, { platform: "linux", exec: cyc }))], [10, 20]);
  // Lookup failure still returns the pid itself.
  assert.deepEqual([...(await ancestorPids(7, { platform: "linux", exec: fakeExec({}) }))], [7]);
});

test("ancestorPids on this machine includes our real parent", { skip: process.platform === "win32" }, async () => {
  const chain = await ancestorPids(process.pid);
  assert.ok(chain.has(process.pid) && chain.has(process.ppid));
});

test("windowsProcessUser reads the owner from tasklist /V output", async () => {
  const exec = fakeExec({ "tasklist /V /FO CSV /NH /FI PID eq 7312": fx("tasklist-verbose-win32.txt") });
  assert.equal(await windowsProcessUser(7312, exec), "DESKTOP-7Q2\\devuser");
  // "N/A" (e.g. a service we cannot inspect) means unknown -> kill will refuse.
  const na = fakeExec({ "tasklist /V": fx("tasklist-verbose-na-win32.txt") });
  assert.equal(await windowsProcessUser(1048, na), null);
  // Non-verbose output (wrong columns) must not be misread as an owner.
  const short = fakeExec({ "tasklist /V": fx("tasklist-win32.txt") });
  assert.equal(await windowsProcessUser(7312, short), null);
  // "INFO: No tasks are running..." -> null
  assert.equal(await windowsProcessUser(5, fakeExec({ "tasklist /V": "INFO: No tasks are running which match the specified criteria.\r\n" })), null);
});
